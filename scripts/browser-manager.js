import puppeteer from 'puppeteer';
import { docSources, crawlerConfig } from '../config/doc-sources.js';

export class BrowserManager {
    constructor() {
        this.browser = null;
        this.pages = new Map();
        this.config = crawlerConfig;
    }

    getChromePath() {
        const platform = process.platform;
        switch (platform) {
            case 'darwin':
                return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
            case 'win32':
                return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
            case 'linux':
                return '/usr/bin/google-chrome';
            default:
                throw new Error(`不支持的操作系统: ${platform}`);
        }
    }

    async init() {
        if (this.browser) return;
        
        try {
            const chromePath = this.getChromePath();
            console.log('[浏览器] 使用Chrome路径:', chromePath);
            
            this.browser = await puppeteer.launch({
                executablePath: chromePath,
                headless: !this.config.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--window-size=1920x1080'
                ]
            });
            
            console.log('[浏览器] 初始化成功');
        } catch (error) {
            console.error('[浏览器] 初始化失败:', error);
            throw error;
        }
    }

    async getPage(url) {
        try {
            // 检查是否已有该URL的页面
            if (this.pages.has(url)) {
                return this.pages.get(url);
            }
            
            // 创建新页面
            const page = await this.browser.newPage();
            
            // 设置页面视口
            await page.setViewport({
                width: 1280,
                height: 800
            });
            
            // 设置页面超时
            page.setDefaultNavigationTimeout(60000); // 60秒
            page.setDefaultTimeout(60000);
            
            // 设置用户代理
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            
            // 禁用图片加载
            await page.setRequestInterception(true);
            page.on('request', request => {
                const resourceType = request.resourceType();
                if (resourceType === 'image') {
                    request.abort();
                } else {
                    request.continue();
                }
            });
            
            // 导航到页面并等待加载
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            }).catch(() => {
                console.log(`[警告] 页面加载超时: ${url}`);
            });
            
            // 等待页面内容加载
            await page.waitForSelector('body', { timeout: 5000 }).catch(() => {
                console.log(`[警告] 等待body超时: ${url}`);
            });
            
            // 保存页面引用
            this.pages.set(url, page);
            
            console.log('[页面] 创建新页面:', url);
            return page;
        } catch (error) {
            console.error('[页面] 创建失败:', error);
            throw error;
        }
    }

    async close() {
        if (!this.browser) return;
        
        try {
            // 关闭所有页面
            for (const [url, page] of this.pages) {
                await page.close().catch(() => {});
                this.pages.delete(url);
            }
            
            // 关闭浏览器
            await this.browser.close();
            this.browser = null;
            
            console.log('[浏览器] 已关闭');
        } catch (error) {
            console.error('[浏览器] 关闭失败:', error);
            throw error;
        }
    }
} 