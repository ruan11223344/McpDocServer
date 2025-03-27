import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from "zod";
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 简单日志函数 - 使用stderr避免干扰MCP通信
const log = (message) => console.error(`[${new Date().toISOString()}] ${message}`);

// 全局文档数据存储
const docData = {};
let docsLoaded = false;
let isLoadingDocs = false;

// 创建MCP服务器
const server = new McpServer({
  name: "文档 MCP 服务器",
  version: "1.0.0"
});

// 加载JS文档文件
async function loadDocFile(filePath) {
  try {
    log(`尝试加载文档文件: ${filePath}`);
    
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      log(`文件不存在: ${filePath}`);
      return null;
    }

    // 将相对路径转为文件URL (ES模块需要完整URL)
    // 对于Windows路径需要特殊处理
    const isWin = process.platform === 'win32';
    let fileUrl;
    
    if (isWin) {
      // Windows路径需要额外处理
      const normalized = path.normalize(filePath).replace(/\\/g, '/');
      fileUrl = `file:///${normalized}`;
    } else {
      // Unix路径处理
      fileUrl = `file://${path.resolve(filePath)}`;
    }
    
    log(`尝试使用动态import加载: ${fileUrl}`);
    
    // 动态导入模块
    const module = await import(fileUrl);
    
    // 检查默认导出
    if (module.default) {
      log(`成功通过import加载(默认导出): ${filePath}`);
      return processDocData(module.default, filePath);
    }
    
    // 如果没有默认导出，尝试查找符合条件的导出
    for (const key in module) {
      if (module[key] && typeof module[key] === 'object') {
        // 检查导出对象是否符合文档格式
        if (module[key].pages || 
            (module[key].source && typeof module[key].source === 'object')) {
          log(`成功通过import加载(命名导出 ${key}): ${filePath}`);
          return processDocData(module[key], filePath);
        }
      }
    }
    
    // 如果没有找到符合条件的导出，尝试使用整个模块
    if (Object.keys(module).length > 0) {
      // 检查整个模块是否可以作为文档数据
      const hasPages = Object.values(module).some(val => 
        typeof val === 'object' && val !== null && 
        (val.title || val.content || val.url)
      );
      
      if (hasPages) {
        log(`将整个模块视为页面集合: ${filePath}`);
        return processDocData({ pages: module }, filePath);
      }
    }
    
    log(`文件已导入但未找到有效的文档数据: ${filePath}`);
    return null;
  } catch (error) {
    log(`动态导入文件失败: ${filePath}, ${error.message}`);
    return null;
  }
}

// 处理文档数据格式
function processDocData(data, filePath) {
  if (!data) return null;
  
  try {
    // 检查是否已经是预期格式
    if (data.pages) {
      // 如果存在source信息，记录
      if (data.source && data.source.name) {
        log(`文档源信息: name=${data.source.name}, url=${data.source.url || '无'}`);
      }
      
      const pageCount = Object.keys(data.pages).length;
      log(`成功加载文档文件: ${filePath}, 页面数: ${pageCount}`);
      
      return {
        source: data.source || { name: path.basename(filePath, path.extname(filePath)) },
        lastUpdated: data.lastUpdated || new Date().toISOString(),
        pages: data.pages
      };
    }
    
    // 检查数据是否直接就是pages对象（键值为URL的对象）
    const isUrlMap = typeof data === 'object' && Object.keys(data).length > 0 && 
                    (Object.keys(data).some(key => 
                      key.startsWith('http') || 
                      (typeof data[key] === 'object' && data[key] && (data[key].url || data[key].title || data[key].content))
                    ));
    
    if (isUrlMap) {
      log(`检测到URL映射格式，转换为标准文档格式: ${filePath}`);
      const fileName = path.basename(filePath, path.extname(filePath));
      return {
        source: { name: fileName },
        lastUpdated: new Date().toISOString(),
        pages: data
      };
    }

    // 检查是否是数组格式
    if (Array.isArray(data)) {
      log(`检测到数组格式，转换为标准文档格式: ${filePath}`);
      const pages = {};
      data.forEach((item, index) => {
        if (item && typeof item === 'object') {
          const id = item.url || item.id || `item-${index}`;
          pages[id] = item;
        }
      });
      
      return {
        source: { name: path.basename(filePath, path.extname(filePath)) },
        lastUpdated: new Date().toISOString(),
        pages: pages
      };
    }
    
    // 检查是否有命名导出
    if (data.default) {
      log(`检测到default导出，使用它作为数据源: ${filePath}`);
      return processDocData(data.default, filePath);
    }
    
    // 如果数据是一个非空对象，但没有pages属性，尝试深入查找可能的数据结构
    if (typeof data === 'object' && Object.keys(data).length > 0) {
      // 检查是否有任何键包含类似页面数据的对象
      for (const key in data) {
        if (data[key] && typeof data[key] === 'object') {
          if (data[key].pages) {
            log(`在键 ${key} 中找到pages对象，使用它作为数据源: ${filePath}`);
            return processDocData(data[key], filePath);
          }
          
          // 检查是否是一个包含多个页面的对象
          const subData = data[key];
          const isPageCollection = Object.keys(subData).length > 0 && 
                                  Object.values(subData).every(v => 
                                    v && typeof v === 'object' && (v.title || v.content || v.url)
                                  );
          
          if (isPageCollection) {
            log(`在键 ${key} 中找到页面集合，转换为标准文档格式: ${filePath}`);
            return {
              source: { name: path.basename(filePath, path.extname(filePath)) },
              lastUpdated: new Date().toISOString(),
              pages: subData
            };
          }
        }
      }
    }
    
    // 其他格式，创建空pages，避免返回null
    log(`无法识别的数据格式，创建包含原始数据的pages: ${filePath}`);
    return {
      source: { name: path.basename(filePath, path.extname(filePath)) },
      lastUpdated: new Date().toISOString(),
      pages: { "data": { title: "原始数据", content: JSON.stringify(data).substring(0, 500) + "..." } }
    };
  } catch (error) {
    log(`处理文档数据时出错: ${filePath}, ${error.message}`);
    // 即使出错，也返回一个有效对象，避免null
    return {
      source: { name: path.basename(filePath, path.extname(filePath)) },
      lastUpdated: new Date().toISOString(),
      pages: { "error": { title: "数据处理错误", content: error.message } }
    };
  }
}

// 确保文档已加载（使用互斥锁防止并发加载）
async function ensureDocsLoaded() {
  // 如果已加载，立即返回
  if (docsLoaded && Object.keys(docData).length > 0) return true;
  
  // 防止并发加载
  if (isLoadingDocs) {
    log('文档正在加载中，等待...');
    while (isLoadingDocs) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return docsLoaded;
  }
  
  // 设置加载标志
  isLoadingDocs = true;
  
  try {
    log('开始加载文档数据...');
    
    // 使用绝对路径而不是当前工作目录
    const docsDir = path.join(__dirname, 'docs');
    log(`尝试从目录加载文档: ${docsDir}`);
    
    // 检查docs目录是否存在
    if (!fs.existsSync(docsDir)) {
      log(`文档目录不存在: ${docsDir}, 尝试使用当前工作目录...`);
      // 回退到使用当前工作目录
      const cwdDocsDir = path.join(process.cwd(), 'docs');
      log(`尝试从当前工作目录加载文档: ${cwdDocsDir}`);
      
      if (!fs.existsSync(cwdDocsDir)) {
        log(`当前工作目录中也不存在docs目录: ${cwdDocsDir}`);
        isLoadingDocs = false;
        return false;
      }
      
      // 使用当前工作目录中的docs
      const result = await loadDocsFromDir(cwdDocsDir);
      isLoadingDocs = false;
      return result;
    }
    
    // 使用项目根目录中的docs
    const result = await loadDocsFromDir(docsDir);
    isLoadingDocs = false;
    return result;
  } catch (error) {
    log(`加载文档过程中出错: ${error.message}`);
    isLoadingDocs = false;
    return false;
  } finally {
    isLoadingDocs = false;
  }
}

// 从指定目录加载文档文件
async function loadDocsFromDir(docsDir) {
  // 扫描docs目录中的所有JSON文件
  const files = fs.readdirSync(docsDir).filter(file => file.endsWith('.json'));
  
  if (files.length === 0) {
    log(`未找到任何JSON文档文件`);
    return false;
  }
  
  log(`找到 ${files.length} 个JSON文档文件: ${files.join(', ')}`);
  
  // 记录加载成功的计数
  let loadedCount = 0;
  
  // 遍历加载每个文件
  for (const file of files) {
    const filePath = path.join(docsDir, file);
    log(`尝试加载文档文件: ${filePath}`);
    
    try {
      // 直接读取文件内容
      const fileContent = fs.readFileSync(filePath, 'utf8');
      log(`文件内容读取成功，大小: ${fileContent.length} 字节`);
      
      // 输出文件内容前20个字符，用于调试
      log(`文件内容前20个字符: "${fileContent.substring(0, 20)}..."`);
      
      // 移除BOM和空白字符
      const cleanContent = fileContent.replace(/^\uFEFF/, '').trim();
      log(`清理后的内容大小: ${cleanContent.length} 字节`);
      
      // 使用JSON.parse解析内容
      try {
        log(`尝试解析JSON...`);
        const docContent = JSON.parse(cleanContent);
        log(`JSON解析成功，开始检查文档格式`);
        
        // 检查文档是否有必要的字段
        if (!docContent.pages) {
          log(`错误: 文档缺少pages字段: ${file}`);
          continue;
        }
        
        // 获取文档源名称（优先使用source.name，或文件名）
        const sourceName = (docContent.source && docContent.source.name) 
          ? docContent.source.name.toLowerCase() 
          : path.basename(file, path.extname(file)).toLowerCase();
        
        log(`成功解析文档数据[${sourceName}]，包含 ${Object.keys(docContent.pages || {}).length} 个页面`);
        
        // 保存到全局文档数据
        docData[sourceName] = {
          source: docContent.source || { name: sourceName },
          lastUpdated: docContent.lastUpdated || new Date().toISOString(),
          pages: docContent.pages || {}
        };
        
        // 检查数据是否已成功保存到docData
        log(`验证数据是否成功保存: ${docData[sourceName] ? '是' : '否'}`);
        log(`数据页面数: ${docData[sourceName] ? Object.keys(docData[sourceName].pages).length : 0}`);
        
        loadedCount++;
      } catch (parseError) {
        log(`JSON解析错误: ${file}, ${parseError.message}`);
        log(`错误位置: ${parseError.stack}`);
      }
    } catch (error) {
      log(`读取文档文件时出错: ${file}, ${error.message}`);
      log(`错误位置: ${error.stack}`);
    }
  }
  
  // 判断加载结果
  if (loadedCount > 0) {
    docsLoaded = true;
    log(`文档加载成功，共加载了 ${loadedCount} 个文档源: ${Object.keys(docData).join(', ')}`);
    return true;
  } else {
    log(`未能成功加载任何文档文件`);
    return false;
  }
}

// 启动服务器
(async () => {
  try {
    log('正在启动文档 MCP 服务器...');
    
    // 输出配置信息
    console.error('\n=== 用于 Cursor 配置的 mcp.json ===\n');
    console.error(JSON.stringify({
      mcpServers: {
        "文档 MCP 服务器": {
          command: "node",
          args: [process.argv[1]],
          env: { "NODE_ENV": "development" }
        }
      }
    }, null, 2));
    console.error('\n=================================\n');
    
    // 尝试从文件加载文档
    log('开始加载文档...');
    const loadResult = await ensureDocsLoaded();
    
    if (loadResult) {
      log(`文档加载成功，共 ${Object.keys(docData).length} 个文档源`);
    } else {
      log('文档加载失败，请确保docs目录中有正确格式的文档文件');
    }
    
    log('文档 MCP 服务器已启动，等待连接...');
    
    // 连接服务器
    await server.connect(new StdioServerTransport());
    log('文档 MCP 服务器已连接');
  } catch (error) {
    log(`服务器启动失败: ${error.message}`);
    process.exit(1);
  }
})();

// 文档搜索工具
// 文档搜索工具
server.tool(
  "search_docs",
  {
    query: z.string().describe("搜索关键词"),
    source: z.string().optional().describe("文档源名称（可选）"),
    limit: z.number().optional().default(10).describe("最大结果数量")
  },
  async ({ query, source, limit }) => {
    log(`收到搜索请求: 关键词="${query}", 源="${source || '所有'}", 限制=${limit}`);
    log(`当前文档数据状态: docsLoaded=${docsLoaded}, docData键数量=${Object.keys(docData).length}`);
    log(`当前进程工作目录: ${process.cwd()}`);
    log(`当前脚本目录: ${__dirname}`);

    try {
      // 特殊命令处理 - reload
      if (query.toLowerCase() === "reload") {
        log("收到重新加载文档指令");
        docsLoaded = false;
        Object.keys(docData).forEach(key => delete docData.key);
        const loadResult = await ensureDocsLoaded();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: loadResult ? "文档已重新加载成功" : "文档重新加载失败",
              sources: Object.keys(docData),
              count: Object.keys(docData).length,
              cwd: process.cwd(),
              scriptDir: __dirname
            }, null, 2)
          }]
        };
      }

      // 确保有数据可用
      if (Object.keys(docData).length === 0) {
        log(`文档数据为空，尝试重新加载...`);
        const loadResult = await ensureDocsLoaded();
        log(`重新加载结果: ${loadResult}, docData键数量=${Object.keys(docData).length}`);

        if (!loadResult || Object.keys(docData).length === 0) {
          log(`重新加载后文档仍然不可用`);
          // ... (保留原有的示例数据加载逻辑) ...
        }
      }

      // 获取要搜索的文档
      let docs = {};
      if (source) {
        const sourceLower = source.toLowerCase();
        if (!docData.hasOwnProperty(sourceLower) || !docData.pages) { // 修改了这里的判断
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `未找到文档源 "${source}"`,
                availableSources: Object.keys(docData),
                docDataStatus: {
                  keys: Object.keys(docData),
                  count: Object.keys(docData).length
                }
              }, null, 2)
            }]
          };
        }
        docs = docData.hasOwnProperty(sourceLower) ? docData.pages : {}; // 修改了这里的赋值
      } else {
        Object.entries(docData).forEach(([name, data]) => {
          if (data && data.pages) {
            Object.entries(data.pages).forEach(([id, page]) => {
              docs = { ...docs, [id]: { ...page, source: name } }; // 更安全地合并
            });
          }
        });
      }

      const normalizedQuery = query.toLowerCase().trim();

      // 分割查询字符串
      const queryTerms = normalizedQuery.split(/\s+/).filter(term => term.length > 0);

      // 进行搜索
      const results = Object.entries(docs)
        .map(([id, doc]) => {
          const title = (doc.title || '').toLowerCase();
          const content = (doc.content || '').toLowerCase();

          // 检查是否所有查询词都包含在标题或内容中
          const allTermsMatch = queryTerms.every(term => title.includes(term) || content.includes(term) || id.toLowerCase().includes(term));

          if (!allTermsMatch) return null;

          // 计算匹配度（可以根据需求调整）
          let score = 0;
          queryTerms.forEach(term => {
            if (title.includes(term)) score += 10;
            if (content.includes(term)) score += 5;
            if (id.toLowerCase().includes(term)) score += 3;
          });

          return {
            id,
            url: id,
            title: doc.title || id,
            content: content.length > 200 ? content.substring(0, 200) + "..." : content,
            score: score,
            source: doc.source || source || null
          };
        })
        .filter(item => item !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      log(`找到 ${results.length} 个匹配结果`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            query: query,
            source: source || "all",
            resultsCount: results.length,
            results: results.length > 0 ? results : [
              {
                id: "no-results",
                title: "没有找到匹配结果",
                content: `未找到与 '${query}' 中所有关键词匹配的内容`,
                score: 0,
                source: null
              }
            ]
          }, null, 2)
        }]
      };
    } catch (error) {
      log(`搜索过程中发生错误: ${error.message}`);
      log(`错误堆栈: ${error.stack}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "搜索过程中发生错误",
            details: error.message,
            stack: error.stack,
            query: query,
            docsLoaded: docsLoaded,
            docDataKeys: Object.keys(docData),
            cwd: process.cwd(),
            scriptDir: __dirname
          }, null, 2)
        }]
      };
    }
  }
);

// 文档详情查询工具
server.tool(
  "get_doc_detail",
  { 
    id: z.string().describe("文档ID"),
    source: z.string().optional().describe("文档源名称（如不提供，将搜索所有源）")
  },
  async ({ id, source }) => {
    log(`收到文档详情请求: ID="${id}", 源="${source || '所有'}"`);
    
    try {
      // 确保文档已加载
      if (Object.keys(docData).length === 0) {
        log(`文档数据为空，尝试加载...`);
        const loadResult = await ensureDocsLoaded();
        if (!loadResult || Object.keys(docData).length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ 
                error: "文档数据不可用",
                message: "无法加载文档数据"
              }, null, 2)
            }]
          };
        }
      }
      
      // 查找指定的文档
      let docDetail = null;
      
      if (source) {
        // 在指定源中查找文档
        const sourceLower = source.toLowerCase();
        if (!docData[sourceLower] || !docData[sourceLower].pages) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ 
                error: `未找到文档源 "${source}"`,
                availableSources: Object.keys(docData)
              }, null, 2)
            }]
          };
        }
        
        if (docData[sourceLower].pages[id]) {
          const page = docData[sourceLower].pages[id];
          docDetail = {
            id,
            title: page.title || id,
            content: page.content || "",
            source: {
              name: sourceLower,
              url: docData[sourceLower].source?.url || ""
            },
            url: id // 使用ID作为URL
          };
        }
      } else {
        // 在所有源中查找文档
        for (const [sourceName, data] of Object.entries(docData)) {
          if (data.pages && data.pages[id]) {
            const page = data.pages[id];
            docDetail = {
              id,
              title: page.title || id,
              content: page.content || "",
              source: {
                name: sourceName,
                url: data.source?.url || ""
              },
              url: id // 使用ID作为URL
            };
            break;
          }
        }
      }
      
      if (!docDetail) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ 
              error: `未找到ID为 "${id}" 的文档`,
              source: source || "all"
            }, null, 2)
          }]
        };
      }
      
      // 返回文档详情
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            document: docDetail
          }, null, 2)
        }]
      };
    } catch (error) {
      log(`获取文档详情时发生错误: ${error.message}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ 
            error: "获取文档详情时发生错误", 
            details: error.message
          }, null, 2)
        }]
      };
    }
  }
);