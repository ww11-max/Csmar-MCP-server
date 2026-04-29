/**
 * CSMAR MCP Server
 * 国泰安(CSMAR)金融数据库的 Model Context Protocol 服务器
 * 支持在 Claude Code 中直接访问 CSMAR 金融数据
 *
 * 优化记录 (v1.2.0):
 *   - 自动检测 Python 路径 (支持 Windows/Mac/Linux)
 *   - 启动前环境检查 (pre-flight check)
 *   - 更清晰的错误提示和排障建议
 *   - 支持 PYTHON_PATH 环境变量覆盖自动检测
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ==================== Python 自动检测 ====================
function detectPythonPath() {
    // 1. 优先使用环境变量
    if (process.env.PYTHON_PATH) {
        return process.env.PYTHON_PATH;
    }

    // 2. 尝试 which/where 命令
    const candidates = [];
    try {
        if (process.platform === 'win32') {
            const result = execSync('where python 2>nul', { encoding: 'utf-8', shell: 'cmd.exe' });
            candidates.push(...result.trim().split('\r\n').map(s => s.trim()).filter(Boolean));
            const result3 = execSync('where python3 2>nul', { encoding: 'utf-8', shell: 'cmd.exe' });
            candidates.push(...result3.trim().split('\r\n').map(s => s.trim()).filter(Boolean));
        } else {
            const result = execSync('which python3 python 2>/dev/null', { encoding: 'utf-8' });
            candidates.push(...result.trim().split('\n').map(s => s.trim()).filter(Boolean));
        }
    } catch (e) { /* ignore */ }

    // 3. 常见安装路径
    const commonPaths = process.platform === 'win32' ? [
        'D:\\python\\python.exe', 'D:\\Python313\\python.exe',
        'D:\\Python312\\python.exe', 'D:\\Python311\\python.exe',
        'C:\\Python314\\python.exe', 'C:\\Python313\\python.exe',
        'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe',
        'C:\\Python310\\python.exe',
        'C:\\Program Files\\Python313\\python.exe',
        'C:\\Program Files\\Python312\\python.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    ] : [
        '/usr/bin/python3', '/usr/local/bin/python3',
        '/usr/bin/python', '/usr/local/bin/python',
        path.join(os.homedir(), '.pyenv', 'shims', 'python3'),
        path.join(os.homedir(), '.pyenv', 'shims', 'python'),
    ];

    for (const p of commonPaths) {
        if (p && !candidates.includes(p) && fs.existsSync(p)) {
            candidates.push(p);
        }
    }

    // 4. 验证每个候选: 检查是否能导入 CSMAR SDK
    for (const pyPath of candidates) {
        try {
            const checkCmd = process.platform === 'win32'
                ? `"${pyPath}" -c "from csmarapi.CsmarService import CsmarService; print('OK')" 2>&1`
                : `'${pyPath}' -c "from csmarapi.CsmarService import CsmarService; print('OK')" 2>&1`;
            const result = execSync(checkCmd, { encoding: 'utf-8', timeout: 5000, shell: true });
            if (result.includes('OK')) {
                console.error(`[CSMAR] 自动检测到 Python (含CSMAR SDK): ${pyPath}`);
                return pyPath;
            }
        } catch (e) { /* 该候选不可用 */ }
    }

    // 5. 回退: 返回第一个可用的 python
    for (const pyPath of candidates) {
        try {
            const result = execSync(`"${pyPath}" --version 2>&1`, { encoding: 'utf-8', timeout: 3000, shell: true });
            if (result.includes('Python')) {
                console.error(`[CSMAR] 使用 Python (未检测到CSMAR SDK): ${pyPath}`);
                return pyPath;
            }
        } catch (e) { /* ignore */ }
    }

    return 'python'; // 最终回退
}

// ==================== 配置 ====================
const CONFIG = {
    name: 'csmar-server',
    version: '1.2.0',
    description: 'MCP server for CSMAR (China Stock Market & Accounting Research) database',

    // CSMAR API
    apiBase: process.env.CSMAR_API_BASE || 'https://api.gtarsc.com',
    apiKey: process.env.CSMAR_API_KEY,

    // 登录凭据
    username: process.env.CSMAR_USERNAME || '',
    password: process.env.CSMAR_PASSWORD || '',
    lang: process.env.CSMAR_LANG || '0',

    // Python 客户端路径 (自动检测)
    pythonPath: detectPythonPath(),
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
            this.process = spawn(CONFIG.pythonPath, [CONFIG.pythonClientPath], {
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

// ==================== 启动前环境检查 ====================
async function preFlightCheck() {
    const checks = [];
    const warnings = [];

    // 检查 Node.js 版本
    const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
    if (nodeMajor < 18) {
        checks.push({ pass: false, msg: `Node.js 版本过低: ${process.version}, 需要 >= 18.0.0` });
    } else {
        checks.push({ pass: true, msg: `Node.js ${process.version}` });
    }

    // 检查 Python
    try {
        const pyVersion = execSync(`"${CONFIG.pythonPath}" --version 2>&1`, { encoding: 'utf-8', timeout: 5000, shell: true });
        checks.push({ pass: true, msg: `Python: ${pyVersion.trim()}` });
    } catch (e) {
        checks.push({
            pass: false,
            msg: `Python 不可用: ${CONFIG.pythonPath}`,
            fix: '请设置 PYTHON_PATH 环境变量指向正确的 Python 可执行文件，或确保 python 在 PATH 中'
        });
    }

    // 检查 CSMAR SDK
    try {
        const checkCmd = `"${CONFIG.pythonPath}" -c "from csmarapi.CsmarService import CsmarService; print('OK')" 2>&1`;
        const result = execSync(checkCmd, { encoding: 'utf-8', timeout: 10000, shell: true });
        if (result.includes('OK')) {
            checks.push({ pass: true, msg: 'CSMAR Python SDK: 已安装' });
        } else {
            throw new Error('SDK check failed');
        }
    } catch (e) {
        checks.push({
            pass: false,
            msg: 'CSMAR Python SDK 未安装或不可用',
            fix: '请从学校图书馆或CSMAR技术支持获取 csmarapi SDK，解压到 Python 的 site-packages 目录'
        });
    }

    // 检查凭据
    if (!CONFIG.username || !CONFIG.password) {
        warnings.push({
            msg: '未配置 CSMAR 登录凭据 (CSMAR_USERNAME / CSMAR_PASSWORD)',
            fix: '请在 .mcp.json 的 env 中设置 CSMAR_USERNAME 和 CSMAR_PASSWORD'
        });
    }

    // 输出检查结果
    console.error('[CSMAR] ========== 环境检查 ==========');
    let allPass = true;
    for (const c of checks) {
        const icon = c.pass ? 'OK' : 'FAIL';
        console.error(`[CSMAR]   [${icon}] ${c.msg}`);
        if (!c.pass) {
            allPass = false;
            if (c.fix) console.error(`[CSMAR]         -> ${c.fix}`);
        }
    }
    for (const w of warnings) {
        console.error(`[CSMAR]   [WARN] ${w.msg}`);
        if (w.fix) console.error(`[CSMAR]         -> ${w.fix}`);
    }
    console.error('[CSMAR] ================================');

    if (!allPass) {
        console.error('[CSMAR] 环境检查未通过，但服务器仍将尝试启动。');
    }
}

// ==================== 启动服务器 ====================

async function main() {
    console.error(`[CSMAR] MCP Server v${CONFIG.version} (Node ${process.version} | ${process.platform})`);

    await preFlightCheck();

    try {
        console.error(`[CSMAR] 使用 Python: ${CONFIG.pythonPath}`);
        await initPythonClient();

        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error('[CSMAR] MCP Server 已就绪');
    } catch (error) {
        console.error('[CSMAR] 启动失败:', error.message);
        console.error('[CSMAR] 排障建议:');
        console.error('[CSMAR]   1. 检查 Python 路径是否正确: PYTHON_PATH=' + CONFIG.pythonPath);
        console.error('[CSMAR]   2. 验证 CSMAR SDK 安装: python -c "from csmarapi.CsmarService import CsmarService"');
        console.error('[CSMAR]   3. 运行手动测试: node src/setup.js');
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('[CSMAR] Server error:', error);
    process.exit(1);
});
