/**
 * CSMAR MCP Server
 * 国泰安(CSMAR)金融数据库的 Model Context Protocol 服务器
 * 支持在 Claude Code 中直接访问 CSMAR 金融数据
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

// ==================== 配置 ====================
const CONFIG = {
    name: 'csmar-server',
    version: '1.1.0',
    description: 'MCP server for CSMAR (China Stock Market & Accounting Research) database',
    
    // CSMAR API 配置
    apiBase: process.env.CSMAR_API_BASE || 'https://api.gtarsc.com',
    apiKey: process.env.CSMAR_API_KEY,
    
    // 登录凭据
    username: process.env.CSMAR_USERNAME,
    password: process.env.CSMAR_PASSWORD,
    lang: process.env.CSMAR_LANG || '0',
    
    // Python 客户端路径
    pythonClientPath: path.join(__dirname, 'python_client.py'),
    
    // 重试配置
    maxRetries: 3,
    retryDelay: 1000,
};

// ==================== MCP 服务器 ====================
const server = new McpServer({
    name: CONFIG.name,
    version: CONFIG.version,
    description: CONFIG.description,
});

// ==================== 持久化 Python 进程 ====================
class PersistentPythonClient {
    constructor() {
        this.process = null;
        this.ready = false;
        this.commandQueue = [];
        this.currentCommand = null;
    }
    
    async start() {
        return new Promise((resolve, reject) => {
            this.process = spawn('python', [CONFIG.pythonClientPath], {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            let stderr = '';
            let stdoutBuffer = '';
            
            this.process.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            this.process.stdout.on('data', (data) => {
                stdoutBuffer += data.toString();
                
                // 按行分割处理
                const lines = stdoutBuffer.split('\n');
                stdoutBuffer = lines.pop() || '';
                
                for (const line of lines) {
                    if (line.trim()) {
                        this.handleOutput(line.trim());
                    }
                }
            });
            
            this.process.on('error', (error) => {
                console.error('[CSMAR] Python 进程启动失败:', error.message);
                reject(error);
            });
            
            this.process.on('close', (code) => {
                console.error(`[CSMAR] Python 进程退出: ${code}`);
                this.ready = false;
            });
            
            // 等待 ready 信号
            const timeout = setTimeout(() => {
                reject(new Error('Python 客户端启动超时'));
            }, 30000);
            
            this.onReady = () => {
                clearTimeout(timeout);
                this.ready = true;
                console.error('[CSMAR] Python 客户端已就绪 (持久化模式)');
                resolve();
            };
            
            this.onResult = (result) => {
                if (this.currentCommand) {
                    this.currentCommand.resolve(result);
                    this.currentCommand = null;
                    this.processQueue();
                }
            };
            
            this.onError = (error) => {
                if (this.currentCommand) {
                    this.currentCommand.reject(error);
                    this.currentCommand = null;
                    this.processQueue();
                }
            };
        });
    }
    
    handleOutput(line) {
        try {
            const data = JSON.parse(line);
            
            if (data.type === 'ready') {
                this.onReady?.(data);
            } else if (data.success === false && data.error) {
                this.onError?.(new Error(data.error));
            } else {
                this.onResult?.(data);
            }
        } catch (e) {
            // 非 JSON 输出，可能是日志
            if (line.includes('[CSMAR]') || line.includes('[ERROR]') || line.includes('[INFO]')) {
                console.error('[Python]', line);
            }
        }
    }
    
    processQueue() {
        if (this.currentCommand || this.commandQueue.length === 0) return;
        
        const next = this.commandQueue.shift();
        this.currentCommand = next;
        
        try {
            this.process.stdin.write(JSON.stringify(next.command) + '\n');
        } catch (e) {
            next.reject(e);
            this.currentCommand = null;
            this.processQueue();
        }
    }
    
    async call(action, params = {}, retries = CONFIG.maxRetries) {
        if (!this.process || !this.ready) {
            throw new Error('Python 客户端未就绪');
        }
        
        return new Promise(async (resolve, reject) => {
            const command = { action, params };
            
            for (let attempt = 0; attempt < retries; attempt++) {
                try {
                    const result = await new Promise((res, rej) => {
                        const timeout = setTimeout(() => {
                            rej(new Error('请求超时'));
                        }, 60000);
                        
                        const originalOnResult = this.onResult;
                        const originalOnError = this.onError;
                        
                        this.onResult = (data) => {
                            clearTimeout(timeout);
                            this.onResult = originalOnResult;
                            this.onError = originalOnError;
                            res(data);
                        };
                        
                        this.onError = (error) => {
                            clearTimeout(timeout);
                            this.onError = originalOnError;
                            this.onResult = originalOnResult;
                            rej(error);
                        };
                        
                        this.commandQueue.push({ command, resolve: res, reject: rej });
                        this.processQueue();
                    });
                    
                    resolve(result);
                    return;
                } catch (error) {
                    if (attempt === retries - 1) {
                        reject(error);
                    } else {
                        await new Promise(r => setTimeout(r, CONFIG.retryDelay * (attempt + 1)));
                    }
                }
            }
        });
    }
    
    stop() {
        if (this.process) {
            this.process.stdin.end();
            this.process.kill();
            this.process = null;
            this.ready = false;
        }
    }
}

// 全局 Python 客户端实例
let pythonClient = null;

// ==================== 工具函数 ====================

// 初始化 Python 客户端
async function initPythonClient() {
    if (!pythonClient) {
        pythonClient = new PersistentPythonClient();
        await pythonClient.start();
    }
    return pythonClient;
}

// 检查 CSMAR 可用性
async function checkAvailability() {
    try {
        const client = await initPythonClient();
        return await client.call('check_availability');
    } catch (error) {
        return { success: false, csmar_available: false, error: error.message };
    }
}

// 检查登录状态
async function checkLoginStatus() {
    const result = await checkAvailability();
    return {
        success: result.success,
        csmar_available: result.csmar_available,
        logged_in: result.client_logged_in,
        username: result.username,
        message: result.message || '检查登录状态成功'
    };
}

// 确保已登录
async function ensureLogin() {
    const status = await checkLoginStatus();
    
    if (!status.csmar_available) {
        return { success: false, error: 'CSMAR SDK 不可用，请检查安装和配置' };
    }
    
    if (status.logged_in) {
        return { success: true, message: '已登录', username: status.username };
    }
    
    if (!CONFIG.username || !CONFIG.password) {
        return { success: false, error: '未配置 CSMAR 凭据，请设置 CSMAR_USERNAME 和 CSMAR_PASSWORD' };
    }
    
    try {
        const client = await initPythonClient();
        return await client.call('login', { 
            account: CONFIG.username, 
            pwd: CONFIG.password, 
            lang: CONFIG.lang 
        });
    } catch (error) {
        return { success: false, error: `登录失败: ${error.message}` };
    }
}

// ==================== 注册 MCP 工具 ====================

// 1. 健康检查工具
server.registerTool(
    'csmar_health_check',
    {
        description: '检查 CSMAR 服务健康状态',
        inputSchema: {},
    },
    async () => {
        try {
            const availability = await checkAvailability();
            const loginStatus = await checkLoginStatus();
            
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        python_client: availability.csmar_available ? '可用' : '不可用',
                        csmar_sdk: availability.csmar_available ? '已安装' : '未安装',
                        logged_in: loginStatus.logged_in,
                        username: loginStatus.username,
                        api_base: CONFIG.apiBase,
                        version: CONFIG.version
                    }, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `健康检查失败: ${error.message}` }],
                isError: true
            };
        }
    }
);

// 2. 登录工具
server.registerTool(
    'csmar_login',
    {
        description: '登录 CSMAR 账户',
        inputSchema: {
            account: z.string().describe('用户名/已验证电话/已验证邮箱'),
            pwd: z.string().describe('密码'),
            lang: z.enum(['0', '1']).optional().describe('语言: 0=中文, 1=英文'),
        },
    },
    async ({ account, pwd, lang = '0' }) => {
        try {
            const client = await initPythonClient();
            const result = await client.call('login', { account, pwd, lang });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `登录错误: ${error.message}` }], isError: true };
        }
    }
);

// 3. 列出数据库
server.registerTool(
    'csmar_list_databases',
    {
        description: '列出用户有权访问的 CSMAR 数据库',
        inputSchema: {},
    },
    async () => {
        try {
            const loginResult = await ensureLogin();
            if (!loginResult.success) {
                return { content: [{ type: 'text', text: JSON.stringify(loginResult, null, 2) }], isError: true };
            }
            
            const client = await initPythonClient();
            const result = await client.call('list_databases');
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `获取数据库列表错误: ${error.message}` }], isError: true };
        }
    }
);

// 4. 列出表
server.registerTool(
    'csmar_list_tables',
    {
        description: '列出指定数据库中的所有表',
        inputSchema: {
            database_name: z.string().describe('数据库名称'),
        },
    },
    async ({ database_name }) => {
        try {
            const loginResult = await ensureLogin();
            if (!loginResult.success) {
                return { content: [{ type: 'text', text: JSON.stringify(loginResult, null, 2) }], isError: true };
            }
            
            const client = await initPythonClient();
            const result = await client.call('list_tables', { database_name });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `获取表列表错误: ${error.message}` }], isError: true };
        }
    }
);

// 5. 列出字段
server.registerTool(
    'csmar_list_fields',
    {
        description: '列出指定表中的所有字段',
        inputSchema: {
            table_name: z.string().describe('表名称'),
        },
    },
    async ({ table_name }) => {
        try {
            const loginResult = await ensureLogin();
            if (!loginResult.success) {
                return { content: [{ type: 'text', text: JSON.stringify(loginResult, null, 2) }], isError: true };
            }
            
            const client = await initPythonClient();
            const result = await client.call('list_fields', { table_name });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `获取字段列表错误: ${error.message}` }], isError: true };
        }
    }
);

// 6. 通用查询
server.registerTool(
    'csmar_query',
    {
        description: '通用 CSMAR 数据查询',
        inputSchema: {
            table_name: z.string().describe('表名称'),
            columns: z.array(z.string()).optional().describe('要查询的字段列表'),
            condition: z.string().optional().describe('查询条件 (SQL WHERE 子句)'),
            start_time: z.string().optional().describe('开始时间 (YYYY-MM-DD)'),
            end_time: z.string().optional().describe('结束时间 (YYYY-MM-DD)'),
            limit: z.number().optional().describe('返回记录数限制'),
            format: z.enum(['json', 'dataframe']).optional().describe('返回格式'),
        },
    },
    async ({ table_name, columns = [], condition = '', start_time, end_time, limit, format = 'json' }) => {
        try {
            const loginResult = await ensureLogin();
            if (!loginResult.success) {
                return { content: [{ type: 'text', text: JSON.stringify(loginResult, null, 2) }], isError: true };
            }
            
            const client = await initPythonClient();
            const result = await client.call('query', { table_name, columns, condition, start_time, end_time, limit, format });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `查询错误: ${error.message}` }], isError: true };
        }
    }
);

// 7. 预览表数据
server.registerTool(
    'csmar_preview',
    {
        description: '预览表数据 (前几行)',
        inputSchema: {
            table_name: z.string().describe('表名称'),
        },
    },
    async ({ table_name }) => {
        try {
            const loginResult = await ensureLogin();
            if (!loginResult.success) {
                return { content: [{ type: 'text', text: JSON.stringify(loginResult, null, 2) }], isError: true };
            }
            
            const client = await initPythonClient();
            const result = await client.call('preview', { table_name });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `预览错误: ${error.message}` }], isError: true };
        }
    }
);

// 8. 查询记录数
server.registerTool(
    'csmar_query_count',
    {
        description: '查询满足条件的记录数量',
        inputSchema: {
            table_name: z.string().describe('表名称'),
            columns: z.array(z.string()).optional().describe('字段列表'),
            condition: z.string().optional().describe('查询条件'),
            start_time: z.string().optional().describe('开始时间'),
            end_time: z.string().optional().describe('结束时间'),
        },
    },
    async ({ table_name, columns = [], condition = '', start_time, end_time }) => {
        try {
            const loginResult = await ensureLogin();
            if (!loginResult.success) {
                return { content: [{ type: 'text', text: JSON.stringify(loginResult, null, 2) }], isError: true };
            }
            
            const client = await initPythonClient();
            const result = await client.call('query_count', { table_name, columns, condition, start_time, end_time });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `查询数量错误: ${error.message}` }], isError: true };
        }
    }
);

// 9. 获取股票数据 (已实现)
server.registerTool(
    'get_stock_data',
    {
        description: '获取 CSMAR 股票交易数据',
        inputSchema: {
            stock_code: z.string().describe('股票代码'),
            start_date: z.string().describe('开始日期 (YYYY-MM-DD)'),
            end_date: z.string().describe('结束日期 (YYYY-MM-DD)'),
            frequency: z.enum(['daily', 'weekly', 'monthly']).optional().describe('数据频率'),
        },
    },
    async ({ stock_code, start_date, end_date, frequency = 'daily' }) => {
        try {
            const loginResult = await ensureLogin();
            if (!loginResult.success) {
                return { content: [{ type: 'text', text: JSON.stringify(loginResult, null, 2) }], isError: true };
            }
            
            // 映射频率参数
            const freqMap = { daily: 'D', weekly: 'W', monthly: 'M' };
            const freq = freqMap[frequency] || 'D';
            
            // 使用通用查询获取股票数据
            // 这里假设有一个股票日行情表，实际表名需要根据数据库确定
            const client = await initPythonClient();
            const result = await client.call('query', {
                table_name: 'stock_daily',
                columns: ['Stkcd', 'Trddt', 'Open', 'High', 'Low', 'Close', 'Vol', 'Amount'],
                condition: `Stkcd='${stock_code}'`,
                start_time: start_date,
                end_time: end_date,
                limit: 1000
            });
            
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `获取股票数据错误: ${error.message}` }], isError: true };
        }
    }
);

// 10. 获取财务数据 (已实现)
server.registerTool(
    'get_financial_data',
    {
        description: '获取 CSMAR 财务数据',
        inputSchema: {
            stock_code: z.string().describe('股票代码'),
            start_date: z.string().describe('开始日期 (YYYY-MM-DD)'),
            end_date: z.string().describe('结束日期 (YYYY-MM-DD)'),
            indicators: z.array(z.string()).optional().describe('财务指标列表'),
        },
    },
    async ({ stock_code, start_date, end_date, indicators = [] }) => {
        try {
            const loginResult = await ensureLogin();
            if (!loginResult.success) {
                return { content: [{ type: 'text', text: JSON.stringify(loginResult, null, 2) }], isError: true };
            }
            
            // 财务报表主表
            const columns = indicators.length > 0 ? indicators : ['Stkcd', 'ShortName', 'Accper', 'Typrep', 'A001000000', 'A002000000'];
            
            const client = await initPythonClient();
            const result = await client.call('query', {
                table_name: 'FS_Combas',
                columns,
                condition: `Stkcd='${stock_code}'`,
                start_time: start_date,
                end_time: end_date,
                limit: 100
            });
            
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `获取财务数据错误: ${error.message}` }], isError: true };
        }
    }
);

// 11. 获取公司信息 (已实现)
server.registerTool(
    'get_company_info',
    {
        description: '获取公司基本信息',
        inputSchema: {
            stock_code: z.string().describe('股票代码'),
        },
    },
    async ({ stock_code }) => {
        try {
            const loginResult = await ensureLogin();
            if (!loginResult.success) {
                return { content: [{ type: 'text', text: JSON.stringify(loginResult, null, 2) }], isError: true };
            }
            
            const client = await initPythonClient();
            
            // 尝试从公司基本信息表获取
            const result = await client.call('query', {
                table_name: 'company_basic',
                columns: ['Stkcd', 'ShortName', 'Industry', 'ListDate', 'Province', 'City'],
                condition: `Stkcd='${stock_code}'`,
                limit: 1
            });
            
            if (result.success && result.data && result.data.length > 0) {
                return { content: [{ type: 'text', text: JSON.stringify(result.data[0], null, 2) }] };
            }
            
            return { content: [{ type: 'text', text: JSON.stringify({ stock_code, message: '未找到公司信息' }, null, 2) }] };
        } catch (error) {
            return { content: [{ type: 'text', text: `获取公司信息错误: ${error.message}` }], isError: true };
        }
    }
);

// ==================== 资源 ====================

server.registerResource(
    'csmar://databases',
    'csmar-databases',
    { description: 'CSMAR 可用数据库列表' },
    async (uri) => {
        try {
            const availability = await checkAvailability();
            if (!availability.csmar_available) {
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify({ error: 'CSMAR SDK 不可用' }, null, 2)
                    }]
                };
            }
            
            const loginResult = await ensureLogin();
            if (!loginResult.success) {
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify({ error: loginResult.error }, null, 2)
                    }]
                };
            }
            
            const client = await initPythonClient();
            const result = await client.call('list_databases');
            
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify(result, null, 2)
                }]
            };
        } catch (error) {
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify({ error: error.message }, null, 2)
                }]
            };
        }
    }
);

// ==================== 优雅关闭 ====================

async function shutdown(signal) {
    console.error(`[CSMAR] 收到 ${signal} 信号，开始关闭...`);
    
    if (pythonClient) {
        pythonClient.stop();
    }
    
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ==================== 启动服务器 ====================

async function main() {
    console.error(`[CSMAR] MCP Server v${CONFIG.version} 启动中...`);
    
    try {
        // 预热 Python 客户端
        await initPythonClient();
        
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error('[CSMAR] CSMAR MCP Server running on stdio');
    } catch (error) {
        console.error('[CSMAR] 启动失败:', error.message);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('[CSMAR] Server error:', error);
    process.exit(1);
});
