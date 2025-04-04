import { BrowserManager } from './browser-manager.js';
import fs from 'fs/promises';
import * as fsSync from 'fs';  // 引入同步版本的fs模块
import path from 'path';
import { docSources, crawlerConfig } from '../config/doc-sources.js';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

export class TaskManager {
    constructor() {
        this.tasks = new Map();                // 存储任务的Map
        this.browserManager = new BrowserManager(); // 浏览器管理器
        this.initialized = false;              // 初始化标志
        this.config = crawlerConfig;           // 爬虫配置
        this.activePages = 0;                  // 当前活动的页面数
        this.pendingUrls = new Map();          // 待处理的URL集合,key为url,value为状态对象
        this.processingUrls = new Set();       // 正在处理的URL集合
        this.savedPages = new Map();           // 跟踪哪些URL已成功保存
        this.pendingSaves = new Map();         // 跟踪待保存操作
        this.fileLocks = new Map();            // 文件锁
        this.saveQueue = new Map();            // 文件保存队列
        this.lastSavePromise = new Map();      // 每个文件的最后一次保存操作
    }

    /**
     * 初始化任务管理器
     */
    async init() {
        if (this.initialized) return;
        
        try {
            await this.browserManager.init();
            console.log('[任务] 浏览器初始化成功');
            this.initialized = true;
        } catch (error) {
            console.error('[任务] 初始化失败:', error);
            throw error;
        }
    }

    /**
     * 保存页面数据
     * @param {string} sourceName - 源名称
     * @param {string} url - 页面URL
     * @param {object} pageData - 页面数据
     */
    async savePage(sourceName, url, pageData) {
        try {
            // 确保sourceName有效
            if (!sourceName) {
                console.error(`[保存] 无效的sourceName: ${sourceName}`);
                return;
            }
            
            // 获取当前脚本的目录
            const scriptDir = dirname(fileURLToPath(import.meta.url));
            // 获取项目根目录
            const projectRoot = path.join(scriptDir, '..');
            
            // 确保docs目录存在
            const docsDir = path.join(projectRoot, 'docs');
            await fs.mkdir(docsDir, { recursive: true }).catch(() => {});
            
            // 构建输出文件路径 - 直接使用.json扩展名
            const outputPath = path.join(docsDir, `${sourceName.toLowerCase()}-docs.json`);
            console.log(`[配置] 将为 ${sourceName} 保存文档至: ${outputPath}`);
            
            // 首先，保存到内存缓存
            if (!this.savedPages.has(sourceName)) {
                this.savedPages.set(sourceName, new Map());
            }
            
            // 添加到内存缓存
            this.savedPages.get(sourceName).set(url, pageData);
            
            // 注册此页面以进行保存
            if (!this.pendingSaves.has(sourceName)) {
                this.pendingSaves.set(sourceName, new Set());
            }
            this.pendingSaves.get(sourceName).add(url);
            
            // 安排保存操作（防抖动）
            if (!this._savePromises) this._savePromises = new Map();
            
            if (this._savePromises.has(sourceName)) {
                // 如果已经安排了保存，让它处理这个
                return this._savePromises.get(sourceName);
            }
            
            // 安排一个带防抖动的新保存
            const savePromise = new Promise(resolve => {
                setTimeout(async () => {
                    try {
                        await this._performActualSave(sourceName, outputPath);
                        resolve();
                    } catch (err) {
                        console.error(`[错误] ${sourceName}保存失败:`, err);
                        
                        // 即使保存失败，也要进行重试
                        try {
                            console.log(`[重试] 尝试再次保存 ${sourceName}...`);
                            // 等待一段时间再重试
                            await new Promise(r => setTimeout(r, 3000));
                            await this._performActualSave(sourceName, outputPath);
                            console.log(`[恢复] ${sourceName}重试保存成功`);
                            resolve();
                        } catch (retryError) {
                            console.error(`[严重错误] ${sourceName}重试保存也失败: ${retryError.message}`);
                            
                            // 尝试保存到备用位置
                            try {
                                const backupPath = `${outputPath}.backup-${Date.now()}.json`;
                                console.log(`[紧急备份] 尝试保存到备用位置: ${backupPath}`);
                                
                                // 准备数据
                                const backupData = {
                                    source: {
                                        name: sourceName,
                                        url: this.tasks.get(sourceName)?.url || ''
                                    },
                                    lastUpdated: new Date().toISOString(),
                                    pages: {}
                                };
                                
                                // 将已保存的页面添加到备份数据
                                const savedPagesForSource = this.savedPages.get(sourceName);
                                if (savedPagesForSource) {
                                    for (const [pageUrl, pageData] of savedPagesForSource.entries()) {
                                        try {
                                            const safePageData = this.ensureSafeJsonData(pageData);
                                            backupData.pages[pageUrl] = safePageData;
                                        } catch (e) {
                                            console.warn(`[警告] 无法将页面添加到备份: ${pageUrl}`);
                                        }
                                    }
                                }
                                
                                // 写入备份文件
                                await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2), 'utf-8');
                                console.log(`[紧急备份] 成功保存到: ${backupPath}`);
                            } catch (backupError) {
                                console.error(`[紧急备份失败] ${backupError.message}`);
                            }
                            
                            resolve(); // 仍然解析以允许将来保存
                        }
                    } finally {
                        // 允许安排新的保存
                        this._savePromises.delete(sourceName);
                    }
                }, 1000); // 等待1秒钟以收集多个保存
            });
            
            this._savePromises.set(sourceName, savePromise);
            return savePromise;
        } catch (error) {
            console.error(`[错误] 保存页面失败: ${error.message}`);
        }
    }

    /**
     * 执行实际文件保存的方法 (修复后的版本)
     * @param {string} sourceName - 源名称
     * @param {string} outputPath - 输出文件路径
     */
    async _performActualSave(sourceName, outputPath) {
        // 为此文件创建锁
        const lockFile = `${outputPath}.lock`;
        
        try {
            // 尝试创建锁文件（原子操作）
            await fs.writeFile(lockFile, Date.now().toString(), { 
                flag: 'wx' // 如果文件存在则失败
            }).catch(async err => {
                if (err.code === 'EEXIST') {
                    // 锁存在，检查它是否过时（超过30秒）
                    try {
                        const lockStat = await fs.stat(lockFile);
                        const lockAge = Date.now() - lockStat.mtime.getTime();
                        
                        if (lockAge > 30000) {
                            // 过时的锁，覆盖它
                            console.log(`[锁] 删除${sourceName}的过时锁`);
                            await fs.unlink(lockFile).catch(() => {});
                            await fs.writeFile(lockFile, Date.now().toString());
                        } else {
                            // 最近的锁，等待并重试
                            console.log(`[锁] 等待${sourceName}的锁`);
                            await new Promise(r => setTimeout(r, 2000));
                            throw new Error('锁存在');
                        }
                    } catch (lockErr) {
                        // 如果我们无法检查锁，等待并重试
                        await new Promise(r => setTimeout(r, 2000));
                        throw new Error('锁检查失败');
                    }
                } else {
                    throw err;
                }
            });
            
            // 获取待保存的URL
            const pendingUrls = Array.from(this.pendingSaves.get(sourceName) || []);
            if (pendingUrls.length === 0) {
                console.log(`[保存] ${sourceName}没有待处理的URL`);
                return;
            }
            
            console.log(`[保存] 正在为${sourceName}保存${pendingUrls.length}个页面`);
            
            // 读取现有数据或创建新结构
            let existingData = {
                source: {
                    name: sourceName,
                    url: this.tasks.get(sourceName)?.url || ''
                },
                lastUpdated: new Date().toISOString(),
                pages: {}
            };
            
            // 如果文件存在，尝试读取
            let existingFile = false;
            try {
                if (await fs.access(outputPath).then(() => true).catch(() => false)) {
                    existingFile = true;
                    const content = await fs.readFile(outputPath, 'utf-8');
                    
                    // 优先尝试作为JSON直接解析
                    try {
                        const parsed = JSON.parse(content);
                        if (parsed && typeof parsed === 'object') {
                            existingData = {
                                source: parsed.source || existingData.source,
                                lastUpdated: new Date().toISOString(),
                                pages: parsed.pages || {}
                            };
                            console.log(`[加载] 成功解析JSON数据，包含${Object.keys(existingData.pages || {}).length}个页面`);
                        }
                    } catch (jsonError) {
                        console.log(`[信息] 不是有效的JSON文件，尝试其他格式: ${jsonError.message}`);
                        
                        // 如果不是有效的JSON，尝试匹配export default到最后一个分号
                        try {
                            const match = content.match(/export\s+default\s*({[\s\S]*});/);
                            if (match && match[1]) {
                                try {
                                    // 使用Function构造函数安全地执行JavaScript (比eval安全)
                                    const objStr = `return ${match[1]}`;
                                    const parseFn = new Function(objStr);
                                    const parsed = parseFn();
                                    
                                    if (parsed && typeof parsed === 'object') {
                                        // 确保结构完整
                                        existingData = {
                                            source: parsed.source || existingData.source,
                                            lastUpdated: new Date().toISOString(),
                                            pages: parsed.pages || {}
                                        };
                                        console.log(`[加载] 成功解析JS模块数据，包含${Object.keys(existingData.pages || {}).length}个页面`);
                                    }
                                } catch (fnError) {
                                    console.warn(`[警告] Function解析失败: ${fnError.message}`);
                                    
                                    // 后备方法: 尝试JSON解析
                                    try {
                                        // 修复常见的JSON解析问题
                                        let jsonText = match[1]
                                            // 确保所有键都有双引号
                                            .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":')
                                            // 单引号变双引号
                                            .replace(/'/g, '"')
                                            // 移除尾随逗号
                                            .replace(/,(\s*[\]}])/g, '$1')
                                            // 修复可能的无引号字符串值
                                            .replace(/:(\s*)([^"{}\[\],\s][^,{}\[\]]*?)(\s*)(,|}|])/g, ':"$2"$3$4');
                                        
                                        const parsed = JSON.parse(jsonText);
                                        if (parsed && typeof parsed === 'object') {
                                            existingData = {
                                                source: parsed.source || existingData.source,
                                                lastUpdated: new Date().toISOString(),
                                                pages: parsed.pages || {}
                                            };
                                            console.log(`[加载] 通过JSON方法成功解析数据，包含${Object.keys(existingData.pages || {}).length}个页面`);
                                        }
                                    } catch (jsonError) {
                                        console.warn(`[警告] 所有解析方法都失败: ${jsonError.message}`);
                                        
                                        // 如果现有文件解析失败，创建备份，以便检查问题
                                        const errorBackupPath = `${outputPath}.error-${Date.now()}.bak`;
                                        await fs.copyFile(outputPath, errorBackupPath).catch(() => {});
                                        console.log(`[错误备份] 已创建错误备份: ${errorBackupPath}`);
                                        
                                        // 继续使用空对象
                                        console.log(`[注意] 将使用新的空数据结构`);
                                    }
                                }
                            } else {
                                console.log(`[信息] 未找到export default语句，使用新的数据结构`);
                            }
                        } catch (parseErr) {
                            console.warn(`[警告] 解析现有文件失败: ${parseErr.message}`);
                        }
                    }
                }
            } catch (readErr) {
                console.warn(`[警告] 读取现有文件失败: ${readErr.message}`);
            }
            
            // 确保pages存在
            existingData.pages = existingData.pages || {};
            
            // 用待处理的页面更新
            let updateCount = 0;
            
            // 检测内容相似性的辅助函数
            const isSimilarContent = (content1, content2) => {
                if (!content1 || !content2) return false;
                
                // 如果两个内容完全相同，返回true
                if (content1 === content2) return true;
                
                // 计算相似度（简化版）
                const words1 = content1.split(/\s+/).filter(w => w.length > 3);
                const words2 = content2.split(/\s+/).filter(w => w.length > 3);
                
                // 如果字数差异太大，认为内容不同
                if (Math.abs(words1.length - words2.length) > words1.length * 0.3) return false;
                
                // 计算共同单词数
                const set1 = new Set(words1);
                const commonWords = words2.filter(word => set1.has(word)).length;
                
                // 如果共同单词比例超过70%，认为内容相似
                return commonWords > words2.length * 0.7;
            };
            
            // 检查是否有内容相似的页面
            const findSimilarPage = (url, pageData) => {
                for (const [existingUrl, pageDataObj] of Object.entries(existingData.pages)) {
                    // 跳过自身
                    if (existingUrl === url) continue;
                    
                    // 检查标题和内容是否相似
                    if (pageData.title === pageDataObj.title && 
                        isSimilarContent(pageData.content, pageDataObj.content)) {
                        return existingUrl;
                    }
                }
                return null;
            };
            
            for (const url of pendingUrls) {
                const pageData = this.savedPages.get(sourceName)?.get(url);
                if (pageData) {
                    try {
                        // 确保所有字段安全可序列化
                        const safePageData = this.ensureSafeJsonData(pageData);
                        
                        // 检查是否有内容相似的页面已经存在
                        const similarUrl = findSimilarPage(url, safePageData);
                        if (similarUrl) {
                            console.log(`[相似] 发现相似页面 ${url} 与 ${similarUrl}，跳过保存`);
                            continue; // 跳过保存
                        }
                        
                        // 确保页面数据至少包含必要字段
                        const finalPageData = {
                            title: safePageData.title || '无标题',
                            content: safePageData.content || ''
                        };
                        
                        // 只更新现有数据，而不是替换整个对象
                        existingData.pages[url] = finalPageData;
                        updateCount++;
                    } catch (dataError) {
                        console.warn(`[警告] 处理页面数据时出错 ${url}: ${dataError.message}`);
                        // 尝试使用最小数据
                        try {
                            // 确保至少有标题和内容的占位符
                            existingData.pages[url] = {
                                title: (pageData && pageData.title) ? pageData.title : `页面 ${url.split('/').pop() || '无标题'}`,
                                content: (pageData && pageData.content) ? pageData.content : `加载此页面时出错: ${dataError.message}`
                            };
                            updateCount++;
                        } catch (fallbackError) {
                            console.error(`[错误] 无法保存基本数据 ${url}: ${fallbackError.message}`);
                        }
                    }
                }
            }
            
            // 如果没有更新任何页面，提前返回，避免重写文件
            if (updateCount === 0) {
                console.log(`[跳过] ${sourceName} 没有新页面需要保存`);
                return;
            }
            
            // 更新时间戳
            existingData.lastUpdated = new Date().toISOString();
            
            // 格式化JSON，添加错误处理
            let formattedJson;
            try {
                formattedJson = JSON.stringify(existingData, null, 2);
            } catch (jsonError) {
                console.error(`[严重错误] JSON序列化失败，尝试修复数据: ${jsonError.message}`);
                
                // 尝试使用更安全的序列化方法
                try {
                    // 创建一个安全版本的数据对象
                    const safeData = {
                        source: existingData.source || { name: sourceName, url: this.tasks.get(sourceName)?.url || '' },
                        lastUpdated: new Date().toISOString(),
                        pages: {}
                    };
                    
                    // 只保留能够安全序列化的页面
                    for (const [pageUrl, pageData] of Object.entries(existingData.pages || {})) {
                        try {
                            // 尝试序列化每个页面，如果失败则跳过
                            const testJson = JSON.stringify(this.ensureSafeJsonData(pageData));
                            safeData.pages[pageUrl] = JSON.parse(testJson);
                        } catch (e) {
                            console.warn(`[警告] 页面 ${pageUrl} 无法序列化，将被跳过: ${e.message}`);
                        }
                    }
                    
                    formattedJson = JSON.stringify(safeData, null, 2);
                    console.log(`[恢复] 成功恢复数据，保留了 ${Object.keys(safeData.pages).length} 个页面`);
                } catch (fallbackError) {
                    // 如果所有尝试都失败，创建一个最小化的有效数据
                    console.error(`[严重错误] 无法恢复数据: ${fallbackError.message}`);
                    formattedJson = JSON.stringify({
                        source: { name: sourceName, url: this.tasks.get(sourceName)?.url || '' },
                        lastUpdated: new Date().toISOString(),
                        pages: {}
                    }, null, 2);
                }
            }
            
            // 确保输出路径是有效的
            const jsonOutputPath = outputPath;
            // 输出实际使用的路径用于调试
            console.log(`[路径] 文档将保存至: ${jsonOutputPath}`);
            
            const jsonTempPath = `${jsonOutputPath}.new`;
            const backupPath = `${jsonOutputPath}.bak`;
            
            // 如果原始文件存在，创建备份
            const jsonExists = await fs.access(jsonOutputPath).then(() => true).catch(() => false);
            if (jsonExists) {
                await fs.copyFile(jsonOutputPath, backupPath).catch(() => {});
            }
            
            // 写入JSON临时文件
            await fs.writeFile(jsonTempPath, formattedJson, 'utf-8');
            
            // 将JSON临时文件重命名为实际文件（原子操作）
            await fs.rename(jsonTempPath, jsonOutputPath);
            console.log(`[保存] 已保存为JSON格式: ${jsonOutputPath}`);
            
            // 删除备份文件
            if (fsSync.existsSync(backupPath)) {
                await fs.unlink(backupPath).catch(err => console.warn(`[警告] 无法删除备份文件 ${backupPath}: ${err.message}`));
            }
            
            // 成功！从待处理列表中清除已保存的页面
            for (const url of pendingUrls) {
                this.pendingSaves.get(sourceName)?.delete(url);
            }
            
            console.log(`[保存完成] ${sourceName} - 已保存${updateCount}个页面，总计: ${Object.keys(existingData.pages).length}`);
        } catch (error) {
            console.error(`[保存错误] 保存${sourceName}失败:`, error);
            // 不清除待处理的URL - 它们将在下次重试
        } finally {
            // 移除锁文件
            await fs.unlink(lockFile).catch(() => {});
        }
    }

    /**
     * 确保数据可以安全序列化为JSON
     * @param {object} data - 要处理的数据
     * @returns {object} 安全的可序列化数据
     */
    ensureSafeJsonData(data) {
        if (!data) return data;
        
        // 如果是字符串，确保转义特殊字符
        if (typeof data === 'string') {
            return data
                .replace(/\\/g, '\\\\') // 先转义反斜杠
                .replace(/"/g, '\\"')   // 转义双引号
                .replace(/\n/g, '\\n')  // 转义换行符
                .replace(/\r/g, '\\r')  // 转义回车符
                .replace(/\t/g, '\\t')  // 转义制表符
                .replace(/\f/g, '\\f'); // 转义换页符
        }
        
        // 如果是对象，递归处理所有属性
        if (typeof data === 'object' && data !== null) {
            const result = Array.isArray(data) ? [] : {};
            
            for (const key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    result[key] = this.ensureSafeJsonData(data[key]);
                }
            }
            
            return result;
        }
        
        // 其他类型直接返回
        return data;
    }

    /**
     * 获取标准化的URL，移除参数、锚点和尾部斜杠
     * @param {string} url - 原始URL
     * @returns {string} 标准化的URL
     */
    getNormalizedUrl(url) {
        try {
            const urlObj = new URL(url);
            // 只保留协议、主机和路径部分，移除查询参数和锚点
            let normalizedUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}`;
            // 移除末尾的斜杠
            normalizedUrl = normalizedUrl.replace(/\/$/, '');
            return normalizedUrl;
        } catch (error) {
            console.error(`[错误] 标准化URL失败 (${url}): ${error.message}`);
            return url;
        }
    }

    /**
     * 获取不带锚点的URL
     * @param {string} url - 原始URL
     * @returns {string} 不带锚点的URL
     */
    getUrlWithoutHash(url) {
        try {
            const urlObj = new URL(url);
            return `${urlObj.origin}${urlObj.pathname}${urlObj.search}`;
        } catch (error) {
            console.error(`[错误] 解析URL失败 (${url}): ${error.message}`);
            return url;
        }
    }

    /**
     * 处理单个URL
     * @param {string} url - 要处理的URL
     * @param {object} taskGroup - 任务组
     */
    async processUrl(url, taskGroup) {
        // 获取标准化的URL
        const normalizedUrl = this.getNormalizedUrl(url);
        
        // 检查是否已经处理过
        if (this.processingUrls.has(normalizedUrl) || taskGroup.pages.has(normalizedUrl)) {
            console.log(`[跳过] ${url} 已处理或正在处理中`);
            return;
        }

        let page = null;
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
            try {
                this.processingUrls.add(normalizedUrl);
                this.activePages++;
                console.log(`\n[爬取] ${taskGroup.name} - ${url} (当前活动页面: ${this.activePages}, 重试次数: ${retryCount})`);
                
                // 每次重试都重新获取页面，避免使用分离的Frame
                if (page) {
                    try {
                        await page.close().catch(() => {});
                    } catch (error) {
                        console.log(`[关闭] 关闭旧页面失败: ${error.message}`);
                    }
                    page = null;
                }
                
                page = await this.browserManager.getPage(url);
                
                // 使用更可靠的方式等待页面加载
                try {
                    // 采用更通用的等待策略
                    await page.goto(url, {
                        waitUntil: 'networkidle0', // 使用networkidle0等待所有网络请求完成
                        timeout: 30000 // 30秒超时
                    }).catch(error => {
                        console.log(`[警告] 页面导航错误，但将继续处理: ${error.message}`);
                    });
                    
                    // 确保body元素加载完成
                    await page.waitForSelector('body', { timeout: 10000 }).catch(() => {
                        console.log(`[警告] 等待页面body元素超时: ${url}`);
                    });
                    
                    // 等待动态内容加载
                    await this.waitForDynamicContent(page);
                    
                } catch (navigationError) {
                    console.log(`[警告] 页面加载错误，但将继续处理: ${navigationError.message}`);
                }

                // 添加try-catch保护所有页面操作
                try {
                    // 检查页面是否可用
                    const isPageValid = await page.evaluate(() => true).catch(() => false);
                    if (!isPageValid) {
                        throw new Error("页面不可用，可能已分离");
                    }
                    
                    // 直接从DOM中提取所有链接
                    const links = await page.evaluate(() => {
                        const linkSet = new Set();
                        
                        try {
                            // 获取所有链接
                            const getAllLinks = (node) => {
                                if (!node) return;
                                
                                try {
                                    // 获取所有a标签
                                    const links = node.getElementsByTagName('a');
                                    if (links) {
                                        for (const link of links) {
                                            const href = link.href;
                                            if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                                                linkSet.add(href);
                                            }
                                        }
                                    }
                                    
                                    // 获取所有可能包含链接的元素
                                    const elements = node.getElementsByTagName('*');
                                    if (elements) {
                                        for (const element of elements) {
                                            if (!element) continue;
                                            
                                            try {
                                                // 检查data-href属性
                                                const dataHref = element.getAttribute('data-href');
                                                if (dataHref && !dataHref.startsWith('javascript:') && !dataHref.startsWith('#')) {
                                                    linkSet.add(dataHref);
                                                }
                                                
                                                // 检查data-url属性
                                                const dataUrl = element.getAttribute('data-url');
                                                if (dataUrl && !dataUrl.startsWith('javascript:') && !dataUrl.startsWith('#')) {
                                                    linkSet.add(dataUrl);
                                                }
                                                
                                                // 检查data-link属性
                                                const dataLink = element.getAttribute('data-link');
                                                if (dataLink && !dataLink.startsWith('javascript:') && !dataLink.startsWith('#')) {
                                                    linkSet.add(dataLink);
                                                }
                                                
                                                // 检查href属性
                                                const href = element.getAttribute('href');
                                                if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                                                    linkSet.add(href);
                                                }
                                            } catch (elementError) {
                                                // 忽略单个元素的错误
                                                console.error(`处理元素属性时出错: ${elementError.message}`);
                                            }
                                        }
                                    }
                                } catch (nodeError) {
                                    // 忽略单个节点的错误
                                    console.error(`处理节点时出错: ${nodeError.message}`);
                                }
                            };
                            
                            // 从body开始遍历
                            if (document.body) {
                                getAllLinks(document.body);
                            }
                            
                            // 获取所有可能的内容区域
                            let contentAreas = [];
                            try {
                                contentAreas = [
                                    document.body,
                                    ...Array.from(document.querySelectorAll('article, main, .content, .doc-content, .markdown-body') || []),
                                    ...Array.from(document.querySelectorAll('[class*="content" i], [class*="article" i], [class*="main" i]') || []),
                                    ...Array.from(document.querySelectorAll('.menu, .nav, .sidebar, .toc, .doc-nav') || []),
                                    ...Array.from(document.querySelectorAll('[class*="menu" i], [class*="nav" i], [class*="sidebar" i], [class*="toc" i]') || [])
                                ].filter(area => area);
                            } catch (queryError) {
                                console.error(`查询内容区域时出错: ${queryError.message}`);
                                contentAreas = document.body ? [document.body] : [];
                            }
                            
                            // 从每个区域提取链接
                            contentAreas.forEach(area => {
                                if (area) {
                                    try {
                                        getAllLinks(area);
                                    } catch (areaError) {
                                        console.error(`处理区域时出错: ${areaError.message}`);
                                    }
                                }
                            });
                        } catch (globalError) {
                            console.error(`提取链接时出错: ${globalError.message}`);
                        }
                        
                        return Array.from(linkSet);
                    }).catch(error => {
                        console.warn(`[警告] 提取链接失败，将使用空数组: ${error.message}`);
                        return [];
                    });
                    
                    // 过滤同域名的链接
                    const baseUrl = new URL(taskGroup.url);
                    const sameDomainLinks = links.filter(link => {
                        try {
                            const targetUrl = new URL(link);
                            return targetUrl.hostname === baseUrl.hostname;
                        } catch (e) {
                            return false;
                        }
                    });
                    
                    console.log(`[链接] 发现 ${sameDomainLinks.length} 个同域名链接`);
                    
                    // 提取页面内容
                    const pageData = await page.evaluate(() => {
                        try {
                            // 获取标题
                            const title = document.title || '';
                            
                            // 获取内容
                            let content = '';
                            
                            // 先移除所有script和style标签
                            const tempDoc = document.cloneNode(true);
                            // 只移除非文档内容的脚本和样式
                            tempDoc.querySelectorAll('script:not([type="text/example"]):not([class*="example"]):not([data-type="example"]), style:not([data-example]), link[rel="stylesheet"]').forEach(el => el.remove());
                            
                            // 保留可能是文档示例的代码，但标记它们
                            tempDoc.querySelectorAll('pre, code, [class*="example"], [class*="demo"], [class*="snippet"], [data-lang]').forEach(el => {
                                el.setAttribute('data-is-example', 'true');
                            });
                            
                            // 尝试获取主要内容区域
                            let mainContent = null;
                            try {
                                mainContent = tempDoc.querySelector('.markdown-body, .doc-content, article, main, .content');
                            } catch (queryError) {
                                console.error(`查询主内容区域失败: ${queryError.message}`);
                            }
                            
                            if (mainContent) {
                                try {
                                    content = mainContent.innerText || '';
                                } catch (textError) {
                                    console.error(`提取主内容文本失败: ${textError.message}`);
                                    content = '';
                                }
                            } else {
                                // 如果没有找到主要内容区域，尝试获取所有内容
                                try {
                                    if (tempDoc.body) {
                                        // 移除页面中常见的非文档相关元素
                                        const nonDocElements = tempDoc.body.querySelectorAll('nav, header, footer, aside, .sidebar, .navigation, .menu, .ads, .banner, .cookie-notice, .modal');
                                        nonDocElements.forEach(el => el.remove());
                                        
                                        // 更智能地处理代码元素 - 保留文档中的代码示例
                                        const codeElements = tempDoc.body.querySelectorAll('pre:not([data-is-example="true"]), code:not([data-is-example="true"])');
                                        codeElements.forEach(el => {
                                            // 检查是否在文档内容区域内
                                            const isInContent = el.closest('.doc-content, .markdown-body, article, main, .content, [class*="example"], [class*="demo"]');
                                            // 检查内容是否看起来像示例代码
                                            const textContent = el.textContent || '';
                                            const looksLikeExample = 
                                                (textContent.includes('function') && textContent.includes('{') && textContent.includes('}')) || 
                                                (textContent.includes('class') && textContent.includes('{')) ||
                                                (textContent.includes('<') && textContent.includes('>')) ||
                                                (textContent.includes('@media') || textContent.includes('@import')) ||
                                                (textContent.includes('const ') || textContent.includes('let ')) ||
                                                (textContent.includes('.css') || textContent.includes('.js'));
                                            
                                            // 如果不在内容区域内且不像示例代码，则移除
                                            if (!isInContent && !looksLikeExample) {
                                                el.remove();
                                            } else {
                                                // 如果像示例代码，标记它以便保留
                                                el.setAttribute('data-is-example', 'true');
                                            }
                                        });
                                        
                                        content = tempDoc.body.innerText || '';
                                    } else {
                                        content = '';
                                    }
                                } catch (bodyTextError) {
                                    console.error(`提取body文本失败: ${bodyTextError.message}`);
                                    content = '';
                                }
                            }
                            
                            // 清理内容 - 增强版
                            content = content
                                .replace(/\n{3,}/g, '\n\n') // 将多个连续换行替换为两个换行
                                .replace(/\s+/g, ' ') // 将多个连续空格替换为单个空格
                                .replace(/[{}]/g, match => '\\' + match) // 转义花括号
                                .replace(/["\\]/g, match => '\\' + match) // 转义引号和反斜杠
                                // 删除可能的CSS样式和JavaScript代码片段，但避免删除示例代码
                                .replace(/(?<!example|demo|snippet)[\s\n]*{[\s\S]*?}/g, function(match) {
                                    // 检查上下文判断是否是示例代码
                                    if (match.includes('function') || match.includes('class') || 
                                        match.includes('const ') || match.includes('let ') ||
                                        match.includes('var ') || match.includes('return ') ||
                                        match.includes('@media') || match.includes('import ')) {
                                        return match; // 保留可能的示例代码
                                    }
                                    return ''; // 删除非示例代码
                                })
                                .replace(/(?<!\/\/\s*example[\s\n]*)function\s*\([\s\S]*?\)\s*{[\s\S]*?}/g, function(match) {
                                    // 检查是否有示例代码注释
                                    if (match.includes('// example') || match.includes('/* example') || 
                                        match.includes('// 示例') || match.includes('/* 示例')) {
                                        return match; // 保留有示例注释的代码
                                    }
                                    return ''; // 删除非示例代码
                                })
                                // 保留框架特定的语法
                                .replace(/(?<!\/\/\s*example[\s\n]*)(?<!example|demo|snippet)[\s\n]*var\s+\w+\s*=.*;/g, '')
                                .replace(/(?<!\/\/\s*example[\s\n]*)(?<!example|demo|snippet)[\s\n]*const\s+\w+\s*=.*;/g, '')
                                .replace(/(?<!\/\/\s*example[\s\n]*)(?<!example|demo|snippet)[\s\n]*let\s+\w+\s*=.*;/g, '')
                                .replace(/(?<!\/\/\s*example[\s\n]*)(?<!example|demo|snippet)[\s\n]*import\s+.*;/g, '')
                                .replace(/(?<!\/\/\s*example[\s\n]*)(?<!example|demo|snippet)[\s\n]*export\s+.*;/g, '')
                                // 谨慎处理注释，避免删除有用的文档注释
                                .replace(/\/\*(?!\s*example)[\s\S]*?\*\//g, '')
                                .replace(/(?<!example|demo|snippet)[\s\n]*\/\/(?!\s*example).*\n/g, '\n')
                                .trim();
                            
                            // 确保title也是安全的
                            const safeTitle = title ? 
                                title.replace(/[{}]/g, match => '\\' + match)
                                    .replace(/["\\]/g, match => '\\' + match) : 
                                '';
                            
                            return {
                                title: safeTitle,
                                content: content
                            };
                        } catch (globalError) {
                            console.error(`提取页面内容时出错: ${globalError.message}`);
                            // 返回空数据，避免完全失败
                            return {
                                title: '页面加载错误',
                                content: `无法提取内容: ${globalError.message}`
                            };
                        }
                    }).catch(error => {
                        console.warn(`[警告] 提取内容失败，将使用空数据: ${error.message}`);
                        return {
                            title: '页面提取失败',
                            content: `提取内容错误: ${error.message}`
                        };
                    });
                    
                    // 检查内容是否为空或太少（可能是动态加载尚未完成）
                    if (pageData.content.length < 500) { // 只用字符数量判断，500字符以下认为内容不完整
                        
                        console.log(`[动态内容] 检测到内容较少(${pageData.content.length}字符)，可能是动态加载尚未完成，尝试使用多种方法重新抓取...`);
                        
                        // 1. 尝试点击可能的页面元素来激活内容
                        try {
                            await page.evaluate(() => {
                                // 尝试点击可能是内容触发器的元素
                                const potentialTriggers = [
                                    '.content-trigger', '.doc-content', 'article', 'main', '.content',
                                    '[role="main"]', '[role="article"]', '.article-content',
                                    '.doc-body', '.markdown-body', '.documentation', '#content'
                                ];
                                
                                potentialTriggers.forEach(selector => {
                                    const elements = document.querySelectorAll(selector);
                                    if (elements && elements.length) {
                                        elements.forEach(el => el.click());
                                    }
                                });
                                
                                // 尝试点击页面上所有按钮和链接
                                document.querySelectorAll('button, .btn, [role="button"]').forEach(btn => {
                                    // 排除导航和菜单按钮
                                    if (!btn.closest('nav, header, .menu, .navigation')) {
                                        btn.click();
                                    }
                                });
                            }).catch(e => console.log(`[点击] 点击元素时出错: ${e.message}`));
                            
                            // 等待可能的交互反应
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        } catch (err) {
                            console.log(`[警告] 尝试点击页面元素失败: ${err.message}`);
                        }
                        
                        // 2. 尝试查找并切换到包含内容的iframe
                        try {
                            const frames = await page.frames();
                            if (frames.length > 1) {
                                console.log(`[iframe] 发现页面中有${frames.length}个iframe，尝试从中提取内容`);
                                
                                // 提取所有iframe的内容
                                for (const frame of frames) {
                                    try {
                                        // 检查iframe是否包含实际内容
                                        const frameContent = await frame.evaluate(() => {
                                            const text = document.body ? document.body.innerText : '';
                                            return {
                                                text: text,
                                                length: text.length,
                                                hasContent: text.length > 200
                                            };
                                        });
                                        
                                        if (frameContent.hasContent) {
                                            console.log(`[iframe] 在iframe中发现内容，长度: ${frameContent.length}字符`);
                                            
                                            // 从iframe中提取内容
                                            const iframeData = await frame.evaluate(() => {
                                                // 获取标题
                                                const title = document.title || '';
                                                
                                                // 获取内容
                                                let content = '';
                                                
                                                // 先移除所有script和style标签
                                                const tempDoc = document.cloneNode(true);
                                                // 只移除非文档内容的脚本和样式
                                                tempDoc.querySelectorAll('script:not([type="text/example"]):not([class*="example"]):not([data-type="example"]), style:not([data-example]), link[rel="stylesheet"]').forEach(el => el.remove());
                                                
                                                // 保留可能是文档示例的代码，但标记它们
                                                tempDoc.querySelectorAll('pre, code, [class*="example"], [class*="demo"], [class*="snippet"], [data-lang]').forEach(el => {
                                                    el.setAttribute('data-is-example', 'true');
                                                });
                                                
                                                // 尝试获取主要内容区域
                                                let mainContent = null;
                                                try {
                                                    mainContent = tempDoc.querySelector('.markdown-body, .doc-content, article, main, .content');
                                                } catch (queryError) {
                                                    console.error(`查询主内容区域失败: ${queryError.message}`);
                                                }
                                                
                                                if (mainContent) {
                                                    try {
                                                        content = mainContent.innerText || '';
                                                    } catch (textError) {
                                                        console.error(`提取主内容文本失败: ${textError.message}`);
                                                        content = '';
                                                    }
                                                } else {
                                                    // 如果没有找到主要内容区域，尝试获取所有内容
                                                    try {
                                                        if (tempDoc.body) {
                                                            // 移除页面中常见的非文档相关元素
                                                            const nonDocElements = tempDoc.body.querySelectorAll('nav, header, footer, aside, .sidebar, .navigation, .menu, .ads, .banner, .cookie-notice, .modal');
                                                            nonDocElements.forEach(el => el.remove());
                                                            
                                                            // 更智能地处理代码元素 - 保留文档中的代码示例
                                                            const codeElements = tempDoc.body.querySelectorAll('pre:not([data-is-example="true"]), code:not([data-is-example="true"])');
                                                            codeElements.forEach(el => {
                                                                // 检查是否在文档内容区域内
                                                                const isInContent = el.closest('.doc-content, .markdown-body, article, main, .content, [class*="example"], [class*="demo"]');
                                                                // 检查内容是否看起来像示例代码
                                                                const textContent = el.textContent || '';
                                                                const looksLikeExample = 
                                                                    (textContent.includes('function') && textContent.includes('{') && textContent.includes('}')) || 
                                                                    (textContent.includes('class') && textContent.includes('{')) ||
                                                                    (textContent.includes('<') && textContent.includes('>')) ||
                                                                    (textContent.includes('@media') || textContent.includes('@import')) ||
                                                                    (textContent.includes('const ') || textContent.includes('let ')) ||
                                                                    (textContent.includes('.css') || textContent.includes('.js'));
                                                                
                                                                // 如果不在内容区域内且不像示例代码，则移除
                                                                if (!isInContent && !looksLikeExample) {
                                                                    el.remove();
                                                                } else {
                                                                    // 如果像示例代码，标记它以便保留
                                                                    el.setAttribute('data-is-example', 'true');
                                                                }
                                                            });
                                                            
                                                            content = tempDoc.body.innerText || '';
                                                        } else {
                                                            content = '';
                                                        }
                                                    } catch (bodyTextError) {
                                                        console.error(`提取body文本失败: ${bodyTextError.message}`);
                                                        content = '';
                                                    }
                                                }
                                                
                                                return {
                                                    title: title || '',
                                                    content: content
                                                };
                                            });
                                            
                                            if (iframeData.content && iframeData.content.length > pageData.content.length) {
                                                console.log(`[iframe] 从iframe中提取了更多内容: ${iframeData.content.length}字符`);
                                                if (iframeData.title) pageData.title = iframeData.title;
                                                pageData.content = iframeData.content;
                                            }
                                        }
                                    } catch (frameErr) {
                                        console.log(`[iframe] 访问iframe内容时出错: ${frameErr.message}`);
                                    }
                                }
                            }
                        } catch (frameErr) {
                            console.log(`[警告] 处理iframe时出错: ${frameErr.message}`);
                        }
                        
                        // 3. 尝试直接抓取HTML内容并解析，绕过可能的JavaScript保护
                        try {
                            const htmlContent = await page.content();
                            console.log(`[HTML解析] 获取页面HTML源码，长度: ${htmlContent.length}字符`);
                            
                            // 尝试使用正则表达式直接从HTML中提取主要内容
                            // 常见内容容器的模式
                            const contentPatterns = [
                                /<article[^>]*>([\s\S]*?)<\/article>/i,
                                /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
                                /<div[^>]*class="[^"]*doc-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
                                /<div[^>]*class="[^"]*markdown-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
                                /<main[^>]*>([\s\S]*?)<\/main>/i,
                                /<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>/i
                            ];
                            
                            let bestContent = '';
                            
                            for (const pattern of contentPatterns) {
                                const match = htmlContent.match(pattern);
                                if (match && match[1]) {
                                    // 提取文本内容，移除HTML标签
                                    const extractedText = match[1].replace(/<[^>]*>/g, ' ')
                                        .replace(/\s+/g, ' ')
                                        .trim();
                                    
                                    if (extractedText.length > bestContent.length) {
                                        bestContent = extractedText;
                                    }
                                }
                            }
                            
                            if (bestContent.length > pageData.content.length * 2) {
                                console.log(`[HTML解析] 直接从HTML中提取到内容: ${bestContent.length}字符`);
                                pageData.content = bestContent;
                            }
                        } catch (htmlErr) {
                            console.log(`[警告] 解析HTML内容时出错: ${htmlErr.message}`);
                        }
                        
                        // 4. 检查是否有特殊API请求获取内容（如Ajax）
                        try {
                            // 使用新的方法确保请求拦截已启用
                            const interceptEnabled = await this.ensureRequestInterception(page);
                            
                            if (!interceptEnabled) {
                                console.log(`[API] 无法启用请求拦截，跳过API内容检测`);
                            } else {
                                // 监听请求，确保继续处理所有请求
                                const requestHandler = request => {
                                    try {
                                        request.continue().catch((continueErr) => {
                                            // 检查是否是请求拦截未启用错误
                                            if (continueErr.message && continueErr.message.includes('Request Interception is not enabled')) {
                                                console.log(`[API] 请求拦截未启用，跳过请求处理`);
                                                return;
                                            }
                                            
                                            try {
                                                // 如果continue失败，尝试respond
                                                request.respond({
                                                    status: 200,
                                                    contentType: 'text/plain',
                                                    body: ''
                                                }).catch((respondErr) => {
                                                    // 检查是否是请求拦截未启用错误
                                                    if (respondErr.message && respondErr.message.includes('Request Interception is not enabled')) {
                                                        console.log(`[API] 请求拦截未启用，跳过请求处理`);
                                                        return;
                                                    }
                                                    
                                                    // 如果respond也失败，尝试abort
                                                    request.abort().catch(() => {});
                                                });
                                            } catch (e) {
                                                console.log(`[API] 处理请求失败: ${e.message}`);
                                            }
                                        });
                                    } catch (e) {
                                        console.log(`[API] 处理请求时出错: ${e.message}`);
                                        // 只有在不是拦截未启用错误时才尝试abort
                                        if (!e.message || !e.message.includes('Request Interception is not enabled')) {
                                            try {
                                                request.abort().catch(() => {});
                                            } catch (abortErr) {}
                                        }
                                    }
                                };
                                
                                // 添加监听器，确保请求可以继续
                                page.on('request', requestHandler);
                                
                                // 监听XHR响应
                                const responsePromise = new Promise((resolve) => {
                                    page.once('response', async (response) => {
                                        try {
                                            const url = response.url();
                                            // 检查是否是API请求或文档内容
                                            if (url.includes('/api/') || url.includes('/docs/') || 
                                                url.includes('.json') || url.includes('/content/')) {
                                                const contentType = response.headers()['content-type'] || '';
                                                if (contentType.includes('json') || contentType.includes('text')) {
                                                    const text = await response.text();
                                                    resolve({ url, text });
                                                }
                                            }
                                            resolve(null);
                                        } catch (e) {
                                            resolve(null);
                                        }
                                    });
                                });
                                
                                // 触发可能的Ajax请求
                                await page.reload({ waitUntil: 'networkidle0' });
                                
                                // 等待可能的响应
                                const apiResponse = await Promise.race([
                                    responsePromise,
                                    new Promise(resolve => setTimeout(() => resolve(null), 5000))
                                ]);
                                
                                if (apiResponse && apiResponse.text) {
                                    console.log(`[API] 捕获到API响应: ${apiResponse.url}`);
                                    try {
                                        // 尝试解析JSON
                                        const jsonData = JSON.parse(apiResponse.text);
                                        
                                        // 尝试从JSON提取内容
                                        const contentKeys = ['content', 'body', 'text', 'html', 'data'];
                                        for (const key of contentKeys) {
                                            if (jsonData[key] && typeof jsonData[key] === 'string' && 
                                                jsonData[key].length > pageData.content.length) {
                                                console.log(`[API] 从API响应中提取内容: ${jsonData[key].length}字符`);
                                                pageData.content = jsonData[key];
                                                break;
                                            }
                                        }
                                    } catch (jsonErr) {
                                        // 不是JSON，可能是纯文本
                                        if (apiResponse.text.length > pageData.content.length) {
                                            console.log(`[API] 使用API响应作为内容: ${apiResponse.text.length}字符`);
                                            pageData.content = apiResponse.text;
                                        }
                                    }
                                }
                                
                                // 清理：移除请求监听器
                                try {
                                    // 使用 off 方法替代 removeListener（Puppeteer最新版本的标准方式）
                                    page.off('request', requestHandler);
                                } catch (listenerErr) {
                                    // 如果off方法不存在，则使用removeAllListeners（兼容老版本）
                                    try {
                                        page.removeAllListeners('request');
                                        console.log(`[API] 已移除所有请求监听器`);
                                    } catch (e) {
                                        console.log(`[API] 无法移除请求监听器: ${e.message}`);
                                    }
                                }
                                
                                // 恢复请求拦截状态
                                if (!interceptEnabled) {
                                    try {
                                        // 如果我们启用的拦截，需要关闭它
                                        await page.setRequestInterception(false);
                                        console.log(`[API] 已关闭请求拦截`);
                                    } catch (disableErr) {
                                        console.log(`[警告] 关闭请求拦截失败: ${disableErr.message}`);
                                    }
                                }
                            }
                        } catch (apiErr) {
                            console.log(`[警告] 监听API请求时出错: ${apiErr.message}`);
                            // 确保请求拦截被关闭，防止后续错误
                            try {
                                await page.setRequestInterception(false);
                            } catch (e) {
                                // 忽略关闭失败的错误
                            }
                        }
                        
                        // 5. 最后，尝试常规滚动和重新抓取
                        await this.scrollPageToLoadLazyContent(page);
                        
                        // 等待足够时间后重新抓取
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        
                        // 重新抓取内容
                        const newPageData = await page.evaluate(() => {
                            try {
                                // 获取标题
                                const title = document.title || '';
                                
                                // 获取内容
                                let content = '';
                                
                                // 先移除所有script和style标签以及CSS链接
                                const tempDoc = document.cloneNode(true);
                                // 只移除非文档内容的脚本和样式
                                tempDoc.querySelectorAll('script:not([type="text/example"]):not([class*="example"]):not([data-type="example"]), style:not([data-example]), link[rel="stylesheet"]').forEach(el => el.remove());
                                
                                // 保留可能是文档示例的代码，但标记它们
                                tempDoc.querySelectorAll('pre, code, [class*="example"], [class*="demo"], [class*="snippet"], [data-lang]').forEach(el => {
                                    el.setAttribute('data-is-example', 'true');
                                });
                                
                                // 尝试获取主要内容区域
                                let mainContent = null;
                                try {
                                    mainContent = tempDoc.querySelector('.markdown-body, .doc-content, article, main, .content');
                                } catch (queryError) {
                                    console.error(`查询主内容区域失败: ${queryError.message}`);
                                }
                                
                                if (mainContent) {
                                    try {
                                        content = mainContent.innerText || '';
                                    } catch (textError) {
                                        console.error(`提取主内容文本失败: ${textError.message}`);
                                        content = '';
                                    }
                                } else {
                                    // 如果没有找到主要内容区域，尝试获取所有内容
                                    try {
                                        if (tempDoc.body) {
                                            // 移除页面中常见的非文档相关元素
                                            const nonDocElements = tempDoc.body.querySelectorAll('nav, header, footer, aside, .sidebar, .navigation, .menu, .ads, .banner, .cookie-notice, .modal');
                                            nonDocElements.forEach(el => el.remove());
                                            
                                            // 更智能地处理代码元素 - 保留文档中的代码示例
                                            const codeElements = tempDoc.body.querySelectorAll('pre:not([data-is-example="true"]), code:not([data-is-example="true"])');
                                            codeElements.forEach(el => {
                                                // 检查是否在文档内容区域内
                                                const isInContent = el.closest('.doc-content, .markdown-body, article, main, .content, [class*="example"], [class*="demo"]');
                                                // 检查内容是否看起来像示例代码
                                                const textContent = el.textContent || '';
                                                const looksLikeExample = 
                                                    (textContent.includes('function') && textContent.includes('{') && textContent.includes('}')) || 
                                                    (textContent.includes('class') && textContent.includes('{')) ||
                                                    (textContent.includes('<') && textContent.includes('>')) ||
                                                    (textContent.includes('@media') || textContent.includes('@import')) ||
                                                    (textContent.includes('const ') || textContent.includes('let ')) ||
                                                    (textContent.includes('.css') || textContent.includes('.js'));
                                                
                                                // 如果不在内容区域内且不像示例代码，则移除
                                                if (!isInContent && !looksLikeExample) {
                                                    el.remove();
                                                } else {
                                                    // 如果像示例代码，标记它以便保留
                                                    el.setAttribute('data-is-example', 'true');
                                                }
                                            });
                                            
                                            content = tempDoc.body.innerText || '';
                                        } else {
                                            content = '';
                                        }
                                    } catch (bodyTextError) {
                                        console.error(`提取body文本失败: ${bodyTextError.message}`);
                                        content = '';
                                    }
                                }
                                
                                // 清理内容 - 增强版
                                content = content
                                    .replace(/\n{3,}/g, '\n\n') // 将多个连续换行替换为两个换行
                                    .replace(/\s+/g, ' ') // 将多个连续空格替换为单个空格
                                    .replace(/[{}]/g, match => '\\' + match) // 转义花括号
                                    .replace(/["\\]/g, match => '\\' + match) // 转义引号和反斜杠
                                    // 删除可能的CSS样式和JavaScript代码片段，但避免删除示例代码
                                    .replace(/(?<!example|demo|snippet)[\s\n]*{[\s\S]*?}/g, function(match) {
                                        // 检查上下文判断是否是示例代码
                                        if (match.includes('function') || match.includes('class') || 
                                            match.includes('const ') || match.includes('let ') ||
                                            match.includes('var ') || match.includes('return ') ||
                                            match.includes('@media') || match.includes('import ')) {
                                            return match; // 保留可能的示例代码
                                        }
                                        return ''; // 删除非示例代码
                                    })
                                    .replace(/(?<!\/\/\s*example[\s\n]*)function\s*\([\s\S]*?\)\s*{[\s\S]*?}/g, function(match) {
                                        // 检查是否有示例代码注释
                                        if (match.includes('// example') || match.includes('/* example') || 
                                            match.includes('// 示例') || match.includes('/* 示例')) {
                                            return match; // 保留有示例注释的代码
                                        }
                                        return ''; // 删除非示例代码
                                    })
                                    // 保留框架特定的语法
                                    .replace(/(?<!\/\/\s*example[\s\n]*)(?<!example|demo|snippet)[\s\n]*var\s+\w+\s*=.*;/g, '')
                                    .replace(/(?<!\/\/\s*example[\s\n]*)(?<!example|demo|snippet)[\s\n]*const\s+\w+\s*=.*;/g, '')
                                    .replace(/(?<!\/\/\s*example[\s\n]*)(?<!example|demo|snippet)[\s\n]*let\s+\w+\s*=.*;/g, '')
                                    .replace(/(?<!\/\/\s*example[\s\n]*)(?<!example|demo|snippet)[\s\n]*import\s+.*;/g, '')
                                    .replace(/(?<!\/\/\s*example[\s\n]*)(?<!example|demo|snippet)[\s\n]*export\s+.*;/g, '')
                                    // 谨慎处理注释，避免删除有用的文档注释
                                    .replace(/\/\*(?!\s*example)[\s\S]*?\*\//g, '')
                                    .replace(/(?<!example|demo|snippet)[\s\n]*\/\/(?!\s*example).*\n/g, '\n')
                                    .replace(/<path[^>]*d=\\?"[^"]*\\?"[^>]*>/g, '') // 移除SVG路径数据
                                    .replace(/d=\\?"[mMlLhHvVcCsSqQtTaAzZ0-9\s,.-]+\\?"/g, '') // 移除SVG路径描述数据
                                    .trim();
                                
                                // 确保title也是安全的
                                const safeTitle = title ? 
                                    title.replace(/[{}]/g, match => '\\' + match)
                                        .replace(/["\\]/g, match => '\\' + match) : 
                                    '';
                                
                                return {
                                    title: safeTitle,
                                    content: content
                                };
                            } catch (globalError) {
                                console.error(`重新提取页面内容时出错: ${globalError.message}`);
                                // 返回空数据，避免完全失败
                                return {
                                    title: '页面重新加载错误',
                                    content: `无法重新提取内容: ${globalError.message}`
                                };
                            }
                        }).catch(error => {
                            console.warn(`[警告] 重新提取内容失败: ${error.message}`);
                            return pageData; // 如果重新提取失败，返回原始数据
                        });
                        
                        // 简化判断逻辑：只比较字符长度
                        if (newPageData.content.length > pageData.content.length * 1.2) { // 内容增加20%以上则认为有效
                            console.log(`[动态内容] 重新抓取成功！内容从${pageData.content.length}字符增加到${newPageData.content.length}字符`);
                            // 使用新抓取的数据
                            pageData.title = newPageData.title;
                            pageData.content = newPageData.content;
                        } else {
                            console.log(`[动态内容] 重新抓取未获得明显改进，继续使用原始内容: ${pageData.content.length}字符`);
                        }
                    }
                    
                    // 保存页面数据
                    const pageDataToSave = {
                        title: pageData.title || `页面 ${normalizedUrl.split('/').pop() || '无标题'}`,
                        content: pageData.content || '页面无内容'
                    };
                    
                    taskGroup.pages.set(normalizedUrl, pageDataToSave);

                    // 每爬取一个页面就保存一次
                    await this.savePage(taskGroup.name, normalizedUrl, pageDataToSave);
                    
                    console.log(`[完成] ${taskGroup.name} - ${url}`);
                    
                    // 将新发现的链接添加到待处理集合（仅当页面处理成功时）
                    for (const link of sameDomainLinks) {
                        const normalizedLink = this.getNormalizedUrl(link);
                        // 检查是否是组件链接
                        if (this.isComponentLink(normalizedLink)) {
                            // 检查是否匹配 excludePatterns
                            const taskGroup = this.getTaskGroupByUrl(normalizedLink);
                            if (taskGroup && taskGroup.excludePatterns && taskGroup.excludePatterns.length > 0) {
                                const urlObj = new URL(normalizedLink);
                                const pathname = urlObj.pathname;
                                const pathWithoutHash = pathname.split('#')[0];
                                const pathWithoutTrailingSlash = pathWithoutHash.replace(/\/$/, '');
                                
                                // 如果匹配任何一个 excludePattern，跳过这个链接
                                if (taskGroup.excludePatterns.some(pattern => pattern.test(pathWithoutTrailingSlash))) {
                                    console.log(`[跳过] ${normalizedLink} 匹配排除规则`);
                                    continue;
                                }
                            }
                            
                            // 检查是否已经处理过或正在处理
                            if (!this.processingUrls.has(normalizedLink) && !taskGroup.pages.has(normalizedLink)) {
                                // 检查是否已经在待处理集合中
                                if (!this.pendingUrls.has(normalizedLink)) {
                                    this.pendingUrls.set(normalizedLink, {
                                        url: normalizedLink,
                                        status: 'pending',
                                        retryCount: 0,
                                        lastRetry: null
                                    });
                                }
                            }
                        }
                    }

                    // 如果成功处理，跳出重试循环
                    break;
                } catch (pageOperationError) {
                    console.error(`[错误] 页面操作失败: ${url}`, pageOperationError);
                    // 这个错误不会重新开始重试循环，而是直接抛出让外部catch捕获
                    throw pageOperationError;
                }
            } catch (error) {
                console.error(`[错误] 处理页面失败: ${url}`, error);
                retryCount++;
                
                // 更新URL状态为失败
                const urlState = this.pendingUrls.get(normalizedUrl);
                if (urlState) {
                    urlState.status = 'failed';
                    urlState.error = error.message;
                    urlState.lastRetry = new Date();
                }

                // 如果是Frame分离错误，增加重试间隔
                const retryDelay = error.message && error.message.includes('detached Frame') 
                    ? retryCount * 5000  // Frame分离错误需要更长时间等待
                    : retryCount * 2000; // 其他错误使用标准等待时间

                // 如果还有重试次数，等待一段时间后重试
                if (retryCount < maxRetries) {
                    console.log(`[重试] ${url} 将在 ${retryDelay/1000} 秒后重试...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    // 最后一次尝试失败，但仍然保存一个"错误"页面，避免浪费之前的工作
                    try {
                        console.log(`[保存错误页面] ${url} 将被保存为错误页面`);
                        const errorPageData = {
                            title: `爬取失败: ${url.split('/').pop() || url}`,
                            content: `处理此页面时发生错误: ${error.message}`
                        };
                        
                        taskGroup.pages.set(normalizedUrl, errorPageData);
                        
                        // 保存错误页面数据
                        await this.savePage(taskGroup.name, normalizedUrl, errorPageData);
                        
                        console.log(`[恢复] 已将 ${url} 保存为错误页面`);
                    } catch (saveError) {
                        console.error(`[错误] 无法保存错误页面: ${saveError.message}`);
                    }
                }
            } finally {
                if (page) {
                    try {
                        await page.close().catch(() => {});
                        console.log(`[关闭] 已关闭页面: ${url}`);
                    } catch (closeError) {
                        console.log(`[警告] 关闭页面时出错: ${closeError.message}`);
                    }
                }
                this.processingUrls.delete(normalizedUrl);
                this.activePages--;
                console.log(`[状态] 当前活动页面数: ${this.activePages}`);
            }
        }
    }

    /**
     * 处理URL队列
     */
    async processUrlQueue() {
        while (this.pendingUrls.size > 0 || this.processingUrls.size > 0) {
            // 如果当前处理的页面数达到限制,等待
            while (this.activePages >= this.config.maxConcurrency) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // 计算可以同时处理的URL数量
            const availableSlots = this.config.maxConcurrency - this.activePages;
            if (availableSlots <= 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            
            // 获取待处理的URL
            const pendingUrls = Array.from(this.pendingUrls.entries())
                .filter(([_, state]) => state.status === 'pending')
                .slice(0, availableSlots);
            
            if (pendingUrls.length > 0) {
                // 并发处理多个URL
                await Promise.allSettled(
                    pendingUrls.map(async ([url, state]) => {
                        this.pendingUrls.delete(url);
                        for (const [name, taskGroup] of this.tasks) {
                            await this.processUrl(url, taskGroup);
                        }
                    })
                );
            } else if (this.processingUrls.size === 0) {
                // 如果没有待处理的URL且没有正在处理的URL，退出循环
                break;
            } else {
                // 如果还有正在处理的URL，等待一秒后继续检查
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    /**
     * 添加文档源
     * @param {object} source - 文档源配置
     */
    async addSource(source) {
        try {
            console.log(`\n[任务] 添加文档源: ${source.name}`);
            console.log(`[URL] ${source.url}`);

            const taskGroup = {
                name: source.name,
                url: source.url,
                pages: new Map(),
                status: 'pending',
                includePatterns: source.includePatterns,
                excludePatterns: source.excludePatterns
            };

            this.tasks.set(source.name, taskGroup);
            
            // 将起始URL添加到待处理集合
            this.pendingUrls.set(source.url, {
                url: source.url,
                status: 'pending',
                retryCount: 0,
                lastRetry: null
            });
            
            console.log(`[任务] 文档源添加完成: ${source.name}`);
        } catch (error) {
            console.error(`[错误] 初始化文档源失败: ${source.name}`, error);
            throw error;
        }
    }

    /**
     * 根据URL获取对应的任务组
     * @param {string} url - 要查询的URL
     * @returns {object|null} 对应的任务组或null
     */
    getTaskGroupByUrl(url) {
        try {
            const urlObj = new URL(url);
            // 遍历所有任务组，找到匹配的配置
            for (const [_, taskGroup] of this.tasks) {
                const baseUrl = new URL(taskGroup.url);
                if (urlObj.hostname === baseUrl.hostname) {
                    return taskGroup;
                }
            }
            return null;
        } catch (error) {
            console.error('获取任务组失败:', error);
            return null;
        }
    }

    /**
     * 检查是否是组件链接
     * @param {string} url - 要检查的URL
     * @returns {boolean} 是否是组件链接
     */
    isComponentLink(url) {
        try {
            const urlObj = new URL(url);
            // 移除hash部分和末尾斜杠，只匹配路径
            const pathname = urlObj.pathname;
            const pathWithoutHash = pathname.split('#')[0];
            const pathWithoutTrailingSlash = pathWithoutHash.replace(/\/$/, '');

            // 获取当前任务组的配置
            const taskGroup = this.getTaskGroupByUrl(url);
            if (!taskGroup) return false;

            // 1. 首先检查是否匹配 excludePatterns
            if (taskGroup.excludePatterns && taskGroup.excludePatterns.length > 0) {
                for (const pattern of taskGroup.excludePatterns) {
                    if (pattern.test(pathWithoutTrailingSlash)) {
                        return false;
                    }
                }
            }

            // 2. 检查是否匹配 includePatterns
            if (taskGroup.includePatterns && taskGroup.includePatterns.length > 0) {
                let matched = false;
                for (const pattern of taskGroup.includePatterns) {
                    // 将通配符模式转换为正则表达式
                    const regexPattern = pattern
                        .replace(/\*/g, '.*')  // 将*转换为.*
                        .replace(/\?/g, '.')    // 将?转换为.
                        .replace(/\[/g, '[')    // 保持[不变
                        .replace(/\]/g, ']');   // 保持]不变
                    
                    // 确保严格匹配整个路径
                    const regex = new RegExp(regexPattern);
                    if (regex.test(pathWithoutTrailingSlash)) {
                        matched = true;
                        break;
                    }
                }
                // 如果不匹配includePatterns，直接返回false
                if (!matched) return false;
            }

            // 3. 检查完includePatterns和excludePatterns后，默认返回true
            // 这样可以由配置控制，而不是硬编码特定的规则
            return true;
        } catch (error) {
            console.error('检查链接时出错:', error);
            return false;
        }
    }

    /**
     * 处理组件页面
     * @param {string} url - 要处理的URL
     * @param {object} taskGroup - 任务组
     */
    async processComponentPage(url, taskGroup) {
        let page = null;
        try {
            console.log(`\n[处理] ${taskGroup.name} - ${url}`);
            
            // 检查是否已经爬取过
            if (taskGroup.pages.has(url)) {
                console.log(`[跳过] ${url} 已存在,跳过处理`);
                return;
            }
            
            page = await this.browserManager.getPage(url);
            
            // 使用更好的等待策略
            await page.goto(url, {
                waitUntil: 'networkidle0',
                timeout: 30000
            }).catch(() => {
                console.log(`[警告] 页面加载超时,尝试继续处理: ${url}`);
            });
            
            // 确保页面内容加载，滚动页面触发懒加载
            await this.scrollPageToLoadLazyContent(page);
            
            // 直接从DOM中提取内容
            const pageData = await page.evaluate(() => {
                // 清理无关内容
                const cleaned = document.body.cloneNode(true);
                
                // 移除所有script、style和其他非文档内容标签
                cleaned.querySelectorAll('script, style, link[rel="stylesheet"], iframe, nav, header, footer, [data-type="js"], [data-type="css"]').forEach(el => el.remove());
                
                // 提取内容
                const result = {
                    title: '',
                    description: '',
                    props: [],
                    events: [],
                    examples: [],
                    content: []
                };
                
                // 提取标题
                const titleEl = cleaned.querySelector('h1') || 
                              cleaned.querySelector('[class*="title" i]') ||
                              cleaned.querySelector('[id*="title" i]');
                if (titleEl) {
                    result.title = titleEl.textContent.trim();
                }
                
                // 提取描述
                const descEl = cleaned.querySelector('p') ||
                             cleaned.querySelector('[class*="desc" i]') ||
                             cleaned.querySelector('[class*="summary" i]');
                if (descEl) {
                    result.description = descEl.textContent.trim();
                }
                
                // 提取表格内容
                cleaned.querySelectorAll('table').forEach(table => {
                    const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim().toLowerCase());
                    const rows = Array.from(table.querySelectorAll('tr')).slice(1);
                    
                    if (headers.some(h => h.includes('prop') || h.includes('参数') || h.includes('属性'))) {
                        rows.forEach(row => {
                            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
                            if (cells.length >= 2) {
                                result.props.push({
                                    name: cells[0],
                                    type: cells[1],
                                    description: cells[cells.length - 1]
                                });
                            }
                        });
                    } else if (headers.some(h => h.includes('event') || h.includes('事件'))) {
                        rows.forEach(row => {
                            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
                            if (cells.length >= 2) {
                                result.events.push({
                                    name: cells[0],
                                    description: cells[cells.length - 1]
                                });
                            }
                        });
                    }
                });
                
                // 提取代码示例 - 仅保留在内容区域的代码示例
                const contentAreas = cleaned.querySelectorAll('.markdown-body, .doc-content, article, main, .content, [class*="example" i]');
                
                if (contentAreas.length > 0) {
                    contentAreas.forEach(area => {
                        area.querySelectorAll('pre, code, [class*="code" i], [class*="example" i]').forEach(block => {
                            const code = block.textContent.trim();
                            if (code) {
                                const language = block.className.match(/language[-:](\w+)/)?.[1] || 
                                               block.getAttribute('data-lang') ||
                                               'javascript';
                                result.examples.push({ code, language });
                            }
                        });
                    });
                } else {
                    // 如果没有找到内容区域，谨慎提取代码示例
                    cleaned.querySelectorAll('pre, code, [class*="code" i], [class*="example" i]').forEach(block => {
                        // 检查代码示例是否在导航、侧边栏等非内容区域
                        const isInNonContentArea = block.closest('nav, .sidebar, .navigation, .menu');
                        if (!isInNonContentArea) {
                            const code = block.textContent.trim();
                            if (code) {
                                const language = block.className.match(/language[-:](\w+)/)?.[1] || 
                                               block.getAttribute('data-lang') ||
                                               'javascript';
                                result.examples.push({ code, language });
                            }
                        }
                    });
                }
                
                // 提取结构化内容
                const contentWalker = document.createTreeWalker(
                    cleaned,
                    NodeFilter.SHOW_ELEMENT,
                    {
                        acceptNode: (node) => {
                            const validTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI'];
                            return validTags.includes(node.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                        }
                    }
                );

                let currentNode;
                while (currentNode = contentWalker.nextNode()) {
                    const text = currentNode.textContent.trim();
                    if (text) {
                        // 过滤掉可能的JS/CSS代码片段
                        const filteredText = text
                            .replace(/{[\s\S]*?}/g, '') // 移除花括号内的内容
                            .replace(/function\s*\([\s\S]*?\)\s*{[\s\S]*?}/g, '') // 移除函数定义
                            .replace(/var\s+\w+\s*=.*;/g, '') // 移除变量定义
                            .replace(/const\s+\w+\s*=.*;/g, '') // 移除常量定义
                            .replace(/let\s+\w+\s*=.*;/g, '') // 移除let声明
                            .replace(/import\s+.*;/g, '') // 移除import语句
                            .replace(/export\s+.*;/g, '') // 移除export语句
                            .replace(/\/\*[\s\S]*?\*\//g, '') // 移除注释块
                            .replace(/\/\/.*\n/g, '\n') // 移除行注释
                            .replace(/<path[^>]*d=\\?"[^"]*\\?"[^>]*>/g, '') // 移除SVG路径数据
                            .replace(/d=\\?"[mMlLhHvVcCsSqQtTaAzZ0-9\s,.-]+\\?"/g, '') // 移除SVG路径描述数据
                            .trim();
                            
                        if (filteredText) {
                            result.content.push({
                                type: currentNode.tagName.toLowerCase(),
                                text: filteredText
                            });
                        }
                    }
                }
                
                return result;
            });
            
            // 检查内容是否足够
            const contentLength = pageData.content.reduce((total, item) => total + item.text.length, 0);
            if (contentLength < 500) {
                console.log(`[动态内容] 组件页面内容较少(${contentLength}字符)，等待更多内容加载后重新抓取`);
                
                // 等待3秒后重新抓取
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // 重新抓取内容
                const newPageData = await page.evaluate(() => {
                    // 清理无关内容
                    const cleaned = document.body.cloneNode(true);
                    
                    // 移除所有script、style和其他非文档内容标签
                    cleaned.querySelectorAll('script, style, link[rel="stylesheet"], iframe, nav, header, footer, [data-type="js"], [data-type="css"]').forEach(el => el.remove());
                    
                    // 提取内容
                    const result = {
                        title: '',
                        description: '',
                        props: [],
                        events: [],
                        examples: [],
                        content: []
                    };
                    
                    // 提取标题
                    const titleEl = cleaned.querySelector('h1') || 
                                  cleaned.querySelector('[class*="title" i]') ||
                                  cleaned.querySelector('[id*="title" i]');
                    if (titleEl) {
                        result.title = titleEl.textContent.trim();
                    }
                    
                    // 提取描述
                    const descEl = cleaned.querySelector('p') ||
                                 cleaned.querySelector('[class*="desc" i]') ||
                                 cleaned.querySelector('[class*="summary" i]');
                    if (descEl) {
                        result.description = descEl.textContent.trim();
                    }
                    
                    // 提取表格内容
                    cleaned.querySelectorAll('table').forEach(table => {
                        const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim().toLowerCase());
                        const rows = Array.from(table.querySelectorAll('tr')).slice(1);
                        
                        if (headers.some(h => h.includes('prop') || h.includes('参数') || h.includes('属性'))) {
                            rows.forEach(row => {
                                const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
                                if (cells.length >= 2) {
                                    result.props.push({
                                        name: cells[0],
                                        type: cells[1],
                                        description: cells[cells.length - 1]
                                    });
                                }
                            });
                        } else if (headers.some(h => h.includes('event') || h.includes('事件'))) {
                            rows.forEach(row => {
                                const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
                                if (cells.length >= 2) {
                                    result.events.push({
                                        name: cells[0],
                                        description: cells[cells.length - 1]
                                    });
                                }
                            });
                        }
                    });
                    
                    // 提取代码示例 - 仅保留在内容区域的代码示例
                    const contentAreas = cleaned.querySelectorAll('.markdown-body, .doc-content, article, main, .content, [class*="example" i]');
                    
                    if (contentAreas.length > 0) {
                        contentAreas.forEach(area => {
                            area.querySelectorAll('pre, code, [class*="code" i], [class*="example" i]').forEach(block => {
                                const code = block.textContent.trim();
                                if (code) {
                                    const language = block.className.match(/language[-:](\w+)/)?.[1] || 
                                                   block.getAttribute('data-lang') ||
                                                   'javascript';
                                    result.examples.push({ code, language });
                                }
                            });
                        });
                    } else {
                        // 如果没有找到内容区域，谨慎提取代码示例
                        cleaned.querySelectorAll('pre, code, [class*="code" i], [class*="example" i]').forEach(block => {
                            // 检查代码示例是否在导航、侧边栏等非内容区域
                            const isInNonContentArea = block.closest('nav, .sidebar, .navigation, .menu');
                            if (!isInNonContentArea) {
                                const code = block.textContent.trim();
                                if (code) {
                                    const language = block.className.match(/language[-:](\w+)/)?.[1] || 
                                                   block.getAttribute('data-lang') ||
                                                   'javascript';
                                    result.examples.push({ code, language });
                                }
                            }
                        });
                    }
                    
                    // 提取结构化内容
                    const contentWalker = document.createTreeWalker(
                        cleaned,
                        NodeFilter.SHOW_ELEMENT,
                        {
                            acceptNode: (node) => {
                                const validTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI'];
                                return validTags.includes(node.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                            }
                        }
                    );

                    let currentNode;
                    while (currentNode = contentWalker.nextNode()) {
                        const text = currentNode.textContent.trim();
                        if (text) {
                            // 过滤掉可能的JS/CSS代码片段
                            const filteredText = text
                                .replace(/{[\s\S]*?}/g, '') // 移除花括号内的内容
                                .replace(/function\s*\([\s\S]*?\)\s*{[\s\S]*?}/g, '') // 移除函数定义
                                .replace(/var\s+\w+\s*=.*;/g, '') // 移除变量定义
                                .replace(/const\s+\w+\s*=.*;/g, '') // 移除常量定义
                                .replace(/let\s+\w+\s*=.*;/g, '') // 移除let声明
                                .replace(/import\s+.*;/g, '') // 移除import语句
                                .replace(/export\s+.*;/g, '') // 移除export语句
                                .replace(/\/\*[\s\S]*?\*\//g, '') // 移除注释块
                                .replace(/\/\/.*\n/g, '\n') // 移除行注释
                                .replace(/<path[^>]*d=\\?"[^"]*\\?"[^>]*>/g, '') // 移除SVG路径数据
                                .replace(/d=\\?"[mMlLhHvVcCsSqQtTaAzZ0-9\s,.-]+\\?"/g, '') // 移除SVG路径描述数据
                                .trim();
                                
                            if (filteredText) {
                                result.content.push({
                                    type: currentNode.tagName.toLowerCase(),
                                    text: filteredText
                                });
                            }
                        }
                    }
                    
                    return result;
                }).catch(error => {
                    console.warn(`[警告] 重新提取组件页面内容失败: ${error.message}`);
                    return pageData; // 如果重新提取失败，返回原始数据
                });
                
                // 计算新的内容长度
                const newContentLength = newPageData.content.reduce((total, item) => total + item.text.length, 0);
                
                // 如果新内容比旧内容长20%以上，使用新内容
                if (newContentLength > contentLength * 1.2) {
                    console.log(`[动态内容] 组件页面重新抓取成功！内容从${contentLength}字符增加到${newContentLength}字符`);
                    // 使用新抓取的数据
                    Object.assign(pageData, newPageData);
                } else {
                    console.log(`[动态内容] 组件页面重新抓取未获得明显改进，继续使用原始内容`);
                }
            }
            
            // 保存页面数据
            taskGroup.pages.set(url, {
                title: pageData.title,
                content: pageData.content
            });

            // 每爬取一个页面就保存一次
            await this.savePage(taskGroup.name, url, {
                title: pageData.title,
                content: pageData.content
            });
            
            console.log(`[完成] ${taskGroup.name} - ${url}`);
        } catch (error) {
            console.error(`[错误] 处理页面失败: ${url}`, error);
        } finally {
            if (page) {
                await page.close().catch(() => {});
                console.log(`[关闭] 已关闭页面: ${url}`);
            }
        }
    }

    /**
     * 等待动态内容加载完成
     * @param {Page} page - Puppeteer页面对象
     * @param {number} timeout - 超时时间(毫秒)，默认为10000ms
     * @returns {Promise<boolean>} 是否检测到动态内容并等待完成
     */
    async waitForDynamicContent(page, timeout = 10000) {
        console.log(`[动态内容] 开始检测动态加载内容...`);
        try {
            // 1. 检测常见的加载指示器
            const loadingSelectors = [
                '.loading', '#loading', '[class*="loading"]', 
                '.spinner', '.loader', '.preloader',
                '[aria-busy="true"]', '[data-loading="true"]'
            ];
            
            // 2. 检测页面中是否存在加载指示器
            const hasLoadingIndicator = await page.evaluate((selectors) => {
                return selectors.some(selector => document.querySelector(selector) !== null);
            }, loadingSelectors);
            
            if (hasLoadingIndicator) {
                console.log(`[动态内容] 检测到加载指示器，等待其消失...`);
                // 等待所有加载指示器消失
                for (const selector of loadingSelectors) {
                    await page.waitForFunction(
                        (sel) => !document.querySelector(sel) || 
                                document.querySelector(sel).style.display === 'none' || 
                                document.querySelector(sel).style.visibility === 'hidden',
                        { timeout },
                        selector
                    ).catch(() => {}); // 忽略超时错误
                }
                console.log(`[动态内容] 加载指示器已消失`);
            }
            
            // 3. 检测DOM的稳定性
            let domStable = false;
            let initialNodeCount = -1;
            let stableCount = 0;
            
            console.log(`[动态内容] 监测DOM稳定性...`);
            const startTime = Date.now();
            
            while (!domStable && (Date.now() - startTime < timeout)) {
                // 获取当前DOM节点数量
                const currentNodeCount = await page.evaluate(() => document.querySelectorAll('*').length);
                
                if (initialNodeCount === -1) {
                    // 第一次检查
                    initialNodeCount = currentNodeCount;
                } else if (currentNodeCount === initialNodeCount) {
                    // DOM节点数量没有变化
                    stableCount++;
                    if (stableCount >= 3) { // 连续3次检查DOM节点数量不变，认为稳定
                        domStable = true;
                        console.log(`[动态内容] DOM已稳定，节点数量: ${currentNodeCount}`);
                    }
                } else {
                    // DOM节点数量有变化，重置计数
                    console.log(`[动态内容] DOM变化中，节点数量从${initialNodeCount}变为${currentNodeCount}`);
                    initialNodeCount = currentNodeCount;
                    stableCount = 0;
                }
                
                // 等待一小段时间再次检查
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            // 4. 等待网络请求完成
            await page.waitForFunction(() => {
                return document.readyState === 'complete';
            }, { timeout: 5000 }).catch(() => {
                console.log(`[动态内容] 等待document.readyState超时`);
            });
            
            // 5. 额外等待一小段时间，确保所有内容都已渲染
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // 6. 尝试滚动页面以触发懒加载
            await this.scrollPageToLoadLazyContent(page);
            
            console.log(`[动态内容] 动态内容加载检测完成`);
            return true;
        } catch (error) {
            console.warn(`[动态内容] 等待动态内容时出错: ${error.message}`);
            return false;
        }
    }
    
    /**
     * 滚动页面以触发懒加载内容
     * @param {Page} page - Puppeteer页面对象
     */
    async scrollPageToLoadLazyContent(page) {
        try {
            // 获取页面高度
            const pageHeight = await page.evaluate(() => document.body.scrollHeight);
            const viewportHeight = await page.evaluate(() => window.innerHeight);
            
            console.log(`[滚动] 开始滚动页面以加载懒加载内容，页面高度: ${pageHeight}px`);
            
            // 使用一个更高效的方法来触发所有懒加载内容
            await page.evaluate(() => {
                return new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 300;
                    const maxScrolls = 20; // 限制最大滚动次数
                    let scrollCount = 0;
                    
                    const timer = setInterval(() => {
                        // 获取当前文档高度，可能在滚动过程中发生变化
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        scrollCount++;
                        
                        // 如果已经滚动到底部或者达到最大滚动次数，停止滚动
                        if (totalHeight >= scrollHeight || scrollCount >= maxScrolls) {
                            clearInterval(timer);
                            window.scrollTo(0, 0); // 滚回顶部
                            resolve();
                        }
                    }, 200);
                });
            }).catch(error => {
                console.warn(`[滚动] 页面滚动脚本执行出错: ${error.message}`);
            });
            
            console.log(`[滚动] 页面滚动完成`);
        } catch (error) {
            console.warn(`[滚动] 滚动页面时出错: ${error.message}`);
        }
    }

    /**
     * 确保请求拦截正确启用
     * @param {Page} page - Puppeteer页面对象
     * @returns {Promise<boolean>} 是否成功启用请求拦截
     */
    async ensureRequestInterception(page) {
        try {
            // 检查当前拦截状态
            const interceptEnabled = await page.evaluate(() => {
                return window._puppeteer_request_interception || false;
            }).catch(() => false);
            
            if (interceptEnabled) {
                // 已经启用，无需再次启用
                return true;
            }
            
            // 确保没有请求监听器
            try {
                page.removeAllListeners('request');
                console.log(`[API] 已移除所有请求监听器，重新启用拦截`);
            } catch (e) {
                // 忽略错误
            }
            
            // 重新启用请求拦截
            await page.setRequestInterception(true);
            
            // 设置标记
            await page.evaluate(() => {
                window._puppeteer_request_interception = true;
            });
            
            console.log(`[API] 已成功启用请求拦截`);
            return true;
        } catch (error) {
            console.log(`[API] 启用请求拦截失败: ${error.message}`);
            return false;
        }
    }
}