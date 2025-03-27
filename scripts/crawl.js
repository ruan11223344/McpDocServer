import { TaskManager } from './task-manager.js';
import { docSources } from '../config/doc-sources.js';
import readline from 'readline';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 创建交互式命令行界面
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// 确保docs目录存在
async function ensureDocsDir() {
    // 使用脚本目录的上一级作为项目根目录
    const projectRoot = path.join(__dirname, '..');
    const docsDir = path.join(projectRoot, 'docs');
    
    try {
        await fs.mkdir(docsDir, { recursive: true });
        console.log(`[系统] 确保docs目录存在: ${docsDir}`);
        return docsDir;
    } catch (error) {
        console.error(`[错误] 创建docs目录失败: ${error.message}`);
        throw error;
    }
}

// 显示菜单并获取用户选择
async function showMenu() {
    console.log('\n可用的文档源:');
    docSources.forEach((source, index) => {
        console.log(`${index + 1}. ${source.name} (${source.url})`);
    });
    console.log('0. 全部爬取');
    console.log('q. 退出程序');
    
    return new Promise((resolve) => {
        rl.question('\n请选择要爬取的文档源 (输入序号): ', (answer) => {
            resolve(answer.trim().toLowerCase());
        });
    });
}

// 主程序
async function main() {
    const taskManager = new TaskManager();
    
    try {
        // 确保docs目录存在
        await ensureDocsDir();
        
        while (true) {
            const choice = await showMenu();
            
            if (choice === 'q') {
                console.log('程序已退出');
                break;
            }
            
            const index = parseInt(choice) - 1;
            
            try {
                // 初始化浏览器
                await taskManager.init();
                
                if (choice === '0') {
                    console.log('\n[开始] 爬取所有文档源...');
                    // 爬取所有文档源
                    for (const source of docSources) {
                        await taskManager.addSource(source);
                    }
                } else if (index >= 0 && index < docSources.length) {
                    console.log(`\n[开始] 爬取文档源: ${docSources[index].name}`);
                    await taskManager.addSource(docSources[index]);
                } else {
                    console.log('\n[错误] 无效的选择，请重新输入');
                    continue;
                }
                
                // 等待队列处理完成
                await taskManager.processUrlQueue();
                
                // 计算总爬取页面数
                let totalPages = 0;
                for (const taskGroup of taskManager.tasks.values()) {
                    if (taskGroup && taskGroup.pages) {
                        totalPages += taskGroup.pages.size;
                    }
                }
                
                console.log(`\n[完成] 爬取任务已完成，共爬取了 ${totalPages} 个页面`);
                
                // 列出所有已爬取的文档源和页面数
                console.log('\n已爬取的文档源:');
                for (const [name, taskGroup] of taskManager.tasks.entries()) {
                    const pageCount = taskGroup.pages ? taskGroup.pages.size : 0;
                    console.log(`- ${name}: ${pageCount} 个页面`);
                }
                
                // 关闭浏览器
                await taskManager.browserManager.close();
                
                // 关闭命令行界面
                rl.close();
                break;
            } catch (error) {
                console.error('\n[错误] 爬取过程出错:', error);
                // 确保浏览器被关闭
                await taskManager.browserManager.close().catch(() => {});
                // 关闭命令行界面
                rl.close();
                break;
            }
        }
    } catch (error) {
        console.error('\n[错误] 程序执行失败:', error);
    } finally {
        // 确保命令行界面被关闭
        try {
            rl.close();
        } catch (e) {
            // 忽略关闭错误
        }
    }
}

// 运行主程序
main().catch(error => {
    console.error('\n[错误] 程序执行失败:', error);
    process.exit(1);
}); 