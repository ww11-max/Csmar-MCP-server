/**
 * CSMAR MCP Server - 环境检查脚本
 * 运行: node src/setup.js
 *
 * 检查 Node.js, Python, CSMAR SDK, 凭据配置等
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const checks = [];
let allPass = true;

function check(name, fn) {
    try {
        const result = fn();
        const icon = result.pass ? 'PASS' : 'FAIL';
        console.log(`  [${icon}] ${name}: ${result.msg}`);
        if (!result.pass && result.fix) {
            console.log(`        -> ${result.fix}`);
            allPass = false;
        }
        if (result.warn) {
            console.log(`        -> ${result.warn}`);
        }
    } catch (e) {
        console.log(`  [FAIL] ${name}: ${e.message}`);
        allPass = false;
    }
}

console.log('========================================');
console.log('  CSMAR MCP Server - 环境检查');
console.log('========================================\n');

// 1. Node.js
check('Node.js 版本', () => {
    const v = process.version;
    const major = parseInt(v.slice(1).split('.')[0], 10);
    return {
        pass: major >= 18,
        msg: v,
        fix: major < 18 ? '请升级 Node.js 到 v18 或更高版本' : undefined
    };
});

// 2. npm 依赖
check('MCP SDK 依赖', () => {
    const sdkPath = path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk');
    return {
        pass: fs.existsSync(sdkPath),
        msg: fs.existsSync(sdkPath) ? '已安装' : '未安装',
        fix: fs.existsSync(sdkPath) ? undefined : '运行: npm install'
    };
});

// 3. Python
let detectedPython = null;
check('Python', () => {
    const candidates = [];

    // 优先使用环境变量
    if (process.env.PYTHON_PATH) {
        candidates.push(process.env.PYTHON_PATH);
    }

    // 从 .env 文件读取
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/^PYTHON_PATH=(.+)$/m);
        if (match && match[1].trim()) {
            candidates.push(match[1].trim());
        }
    }

    candidates.push('python3', 'python');

    for (const py of candidates) {
        try {
            const result = execSync(`"${py}" --version 2>&1`, { encoding: 'utf-8', timeout: 5000, shell: true });
            if (result.includes('Python')) {
                detectedPython = py;
                return { pass: true, msg: `${result.trim()} (${py})` };
            }
        } catch (e) { /* ignore */ }
    }
    return {
        pass: false,
        msg: '未找到可用的 Python',
        fix: '请安装 Python >= 3.8, 或设置环境变量 PYTHON_PATH 指向 Python 可执行文件'
    };
});

// 4. Python 依赖
if (detectedPython) {
    check('Python 依赖 (pandas)', () => {
        try {
            const r = execSync(`"${detectedPython}" -c "import pandas; print(pandas.__version__)" 2>&1`, { encoding: 'utf-8', timeout: 10000, shell: true });
            return { pass: true, msg: `pandas ${r.trim()}` };
        } catch (e) {
            return { pass: false, msg: '未安装', fix: 'pip install pandas' };
        }
    });
}

// 5. CSMAR SDK
if (detectedPython) {
    check('CSMAR Python SDK', () => {
        try {
            const r = execSync(`"${detectedPython}" -c "from csmarapi.CsmarService import CsmarService; print('OK')" 2>&1`, { encoding: 'utf-8', timeout: 10000, shell: true });
            return { pass: r.includes('OK'), msg: r.includes('OK') ? '已安装' : r.trim() };
        } catch (e) {
            return {
                pass: false,
                msg: '未安装或不可用',
                fix: '请从 CSMAR 获取 SDK 并安装到 Python site-packages'
            };
        }
    });

    // 测试网络连通性
    check('CSMAR 服务器连通性', () => {
        try {
            const pyCode = `
import urllib.request, ssl
ctx = ssl.create_default_context()
try:
    req = urllib.request.Request("https://data.csmar.com", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
        print("OK")
except Exception as e:
    print("FAIL:" + str(e))
`;
            const r = execSync(`"${detectedPython}" -c "${pyCode}" 2>&1`, { encoding: 'utf-8', timeout: 15000, shell: true });
            return { pass: r.includes('OK'), msg: r.includes('OK') ? '可连接' : r.trim() };
        } catch (e) {
            return { pass: false, msg: e.message, fix: '请检查网络连接' };
        }
    });
}

// 6. 配置文件
check('.env 配置', () => {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        const hasUser = content.includes('CSMAR_USERNAME=') && !content.includes('CSMAR_USERNAME=\n') && !content.includes('CSMAR_USERNAME=your_');
        const hasPwd = content.includes('CSMAR_PASSWORD=') && !content.includes('CSMAR_PASSWORD=\n') && !content.includes('CSMAR_PASSWORD=your_');
        return {
            pass: hasUser && hasPwd,
            msg: hasUser && hasPwd ? '凭据已配置' : '凭据未配置或使用占位符',
            fix: hasUser && hasPwd ? undefined : '编辑 .env 文件，填入 CSMAR_USERNAME 和 CSMAR_PASSWORD'
        };
    }
    return {
        pass: false,
        msg: '.env 文件不存在',
        fix: '复制 .env.example 为 .env 并填入 CSMAR 凭据: cp .env.example .env'
    };
});

check('.mcp.json 配置', () => {
    // 检查多个可能的路径
    const possiblePaths = [
        path.join(__dirname, '..', '..', '.mcp.json'),       // Claude workspace root
        path.join(os.homedir(), '.claude', '.mcp.json'),     // Claude global config
        path.join(__dirname, '..', '.mcp.json'),             // Project root
    ];
    let foundPath = null;
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            foundPath = p;
            break;
        }
    }
    return {
        pass: !!foundPath,
        msg: foundPath ? `找到: ${foundPath}` : '.mcp.json 未找到 (在项目根目录或 ~/.claude/)',
        fix: foundPath ? undefined : '将 config/.mcp.json 复制到项目根目录的 .claude/.mcp.json，并在其中填入凭据'
    };
});

console.log('\n========================================');
if (allPass) {
    console.log('  所有检查通过! 运行 npm start 启动服务');
} else {
    console.log('  存在未通过的检查，请修复后重试');
}
console.log('========================================\n');
