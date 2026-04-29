#!/usr/bin/env python3
"""
CSMAR Python客户端 - 用于Node.js MCP服务器调用CSMAR Python SDK
通过标准输入/输出JSON进行通信，支持持久化会话模式

用法:
    python python_client.py              # 交互模式 (持久化)
    python python_client.py --once       # 单次调用模式 (从stdin读取一条命令)

优化记录 (v1.2.0):
    - 移除硬编码的Python路径，使用运行时检测
    - 改进错误信息，提供排障建议
    - 添加 CSMAR_SDK_PATH 环境变量支持
"""

import sys
import json
import traceback
import logging
import os
import argparse
import site
from typing import Dict, Any, Optional, List

# ==================== Python 路径自动检测 ====================
def setup_python_paths() -> List[str]:
    """自动检测并设置Python路径以确保可以导入CSMAR SDK"""
    new_paths = []

    # 0. 环境变量覆盖 (最高优先级)
    sdk_path = os.environ.get('CSMAR_SDK_PATH', '')
    if sdk_path and os.path.exists(sdk_path):
        new_paths.append(sdk_path)
        parent = os.path.dirname(sdk_path)
        if parent not in new_paths:
            new_paths.append(parent)

    # 1. 获取系统 site-packages 路径
    try:
        site_packages = site.getsitepackages()
        new_paths.extend(site_packages)
    except Exception:
        pass

    # 2. 用户 site-packages
    try:
        user_site = site.getusersitepackages()
        if user_site and os.path.exists(user_site):
            new_paths.append(user_site)
    except Exception:
        pass

    # 3. 扫描 sys.path 中已有的路径，寻找 csmarapi
    for p in list(sys.path):
        csmarapi_dir = os.path.join(p, "csmarapi")
        if os.path.exists(csmarapi_dir) and csmarapi_dir not in new_paths:
            new_paths.append(csmarapi_dir)

    # 4. 常见安装路径 (跨平台)
    common_base = []
    if sys.platform == 'win32':
        drives = ['D:', 'C:']
        for drive in drives:
            for ver in ['313', '312', '311', '310', '39', '38']:
                common_base.extend([
                    fr"{drive}\Python{ver}\Lib\site-packages",
                    fr"{drive}\python\Lib\site-packages",
                    fr"{drive}\Program Files\Python{ver}\Lib\site-packages",
                ])
        # 用户 AppData 路径
        home = os.path.expanduser("~")
        common_base.append(os.path.join(home, "AppData", "Local", "Programs", "Python", "Python313", "Lib", "site-packages"))
        common_base.append(os.path.join(home, "AppData", "Local", "Programs", "Python", "Python312", "Lib", "site-packages"))
    else:
        common_base.extend([
            "/usr/local/lib/python3.13/site-packages",
            "/usr/local/lib/python3.12/site-packages",
            "/usr/local/lib/python3.11/site-packages",
            "/usr/lib/python3.13/site-packages",
            "/usr/lib/python3.12/site-packages",
            "/usr/lib/python3.11/site-packages",
            os.path.expanduser("~/.local/lib/python3.13/site-packages"),
            os.path.expanduser("~/.local/lib/python3.12/site-packages"),
            os.path.expanduser("~/.local/lib/python3.11/site-packages"),
        ])

    for p in common_base:
        if os.path.exists(p) and p not in new_paths:
            new_paths.append(p)

    # 5. 为每个路径添加 csmarapi 子目录
    extra = []
    for sp in list(new_paths):
        csmarapi_dir = os.path.join(sp, "csmarapi")
        if os.path.exists(csmarapi_dir) and csmarapi_dir not in new_paths:
            extra.append(csmarapi_dir)
    new_paths = extra + new_paths

    # 6. 插入 sys.path (避免重复)
    existing_paths = [p for p in new_paths if os.path.exists(p)]
    for ep in existing_paths:
        if ep not in sys.path:
            sys.path.insert(0, ep)

    return existing_paths


# 执行路径设置
added_paths = setup_python_paths()

# ==================== 日志配置 ====================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger(__name__)

if added_paths:
    logger.info(f"已添加搜索路径: {len(added_paths)} 个")

# ==================== 导入 CSMAR SDK ====================
CSMAR_AVAILABLE = False
CsmarService = None
_sdk_error = None

try:
    from csmarapi.CsmarService import CsmarService
    CSMAR_AVAILABLE = True
    logger.info("CSMAR SDK 导入成功")
except ImportError as e:
    _sdk_error = str(e)
    logger.warning(f"无法导入 CSMAR SDK: {e}")
    logger.info("=== CSMAR SDK 安装指引 ===")
    logger.info("  1. 从学校图书馆或CSMAR技术支持获取 CSMAR-PYTHON SDK 压缩包")
    logger.info("  2. 解压到 Python 的 site-packages 目录")
    logger.info("  3. 或设置 CSMAR_SDK_PATH 环境变量指向 SDK 所在目录")
    logger.info("  4. 确保已安装依赖: pip install pandas urllib3 websocket-client prettytable")


class CSMARClient:
    """CSMAR客户端 - 复用会话实例"""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self.csmar = None
        self.logged_in = False
        self.username = None
        self._initialized = True
        self._try_load_token()

    def _try_load_token(self):
        """尝试从多个位置加载 token.txt"""
        search_paths = [
            os.getcwd(),
            os.path.dirname(os.path.abspath(__file__)),
            os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
        ]
        for sp in search_paths:
            token_path = os.path.join(sp, "token.txt")
            if os.path.exists(token_path):
                self.logged_in = True
                logger.info(f"找到 token.txt ({sp}), 假设已登录")
                return

    def _ensure_csmar(self):
        if not self.csmar:
            if not CSMAR_AVAILABLE:
                raise RuntimeError(
                    "CSMAR SDK 未安装。请:\n"
                    "  1. 从学校图书馆获取 CSMAR-PYTHON SDK\n"
                    "  2. 解压到 Python site-packages 目录\n"
                    "  3. 或设置环境变量 CSMAR_SDK_PATH=/path/to/sdk"
                )
            self.csmar = CsmarService()
        return self.csmar

    def reset(self):
        self.csmar = None
        self.logged_in = False
        self.username = None
        self._try_load_token()
        return self

    def login(self, account: str, pwd: str, lang: str = "0") -> Dict[str, Any]:
        try:
            if not CSMAR_AVAILABLE:
                return {
                    "success": False,
                    "error": "CSMAR SDK 未安装",
                    "detail": "请安装 CSMAR-PYTHON SDK 后重试"
                }

            self.csmar = CsmarService()
            lang_code = 0 if lang == "1" else 1
            result = self.csmar.login(account, pwd, lang_code)

            if result is None:
                try:
                    test_dbs = self.csmar.getListDbs()
                    if test_dbs is not None:
                        self.logged_in = True
                        self.username = account
                        return {"success": True, "message": "登录成功", "username": account}
                except Exception:
                    pass
                return {"success": False, "error": "登录验证失败，请检查用户名和密码"}
            elif isinstance(result, dict):
                if result.get("success", False):
                    self.logged_in = True
                    self.username = account
                    return {"success": True, "message": "登录成功", "username": account}
                else:
                    return {"success": False, "error": "登录失败", "detail": result.get("msg", str(result))}
            else:
                self.logged_in = True
                self.username = account
                return {"success": True, "message": "登录成功", "username": account}

        except Exception as e:
            return {"success": False, "error": f"登录异常: {str(e)}"}

    def get_list_dbs(self) -> Dict[str, Any]:
        try:
            csmar = self._ensure_csmar()
            databases = csmar.getListDbs()
            if databases is None:
                return {"success": False, "error": "数据库列表为空 (可能是权限不足或网络问题)", "databases": [], "count": 0}

            db_list = list(databases) if hasattr(databases, '__iter__') else [str(databases)]
            return {"success": True, "databases": db_list, "count": len(db_list)}
        except Exception as e:
            return {"success": False, "error": f"获取数据库列表失败: {str(e)}"}

    def get_list_tables(self, database_name: str) -> Dict[str, Any]:
        try:
            csmar = self._ensure_csmar()
            tables = csmar.getListTables(database_name)
            if tables is None:
                return {"success": False, "error": f"表列表为空 (数据库: {database_name})", "tables": [], "count": 0}
            table_list = list(tables) if hasattr(tables, '__iter__') else [str(tables)]
            return {"success": True, "database": database_name, "tables": table_list, "count": len(table_list)}
        except Exception as e:
            return {"success": False, "error": f"获取表列表失败: {str(e)}"}

    def get_list_fields(self, table_name: str) -> Dict[str, Any]:
        try:
            csmar = self._ensure_csmar()
            fields = csmar.getListFields(table_name)
            if fields is None:
                return {"success": False, "error": "字段列表为空", "table": table_name, "fields": [], "count": 0}
            field_list = list(fields) if hasattr(fields, '__iter__') else [str(fields)]
            return {"success": True, "table": table_name, "fields": field_list, "count": len(field_list)}
        except Exception as e:
            return {"success": False, "error": f"获取字段列表失败: {str(e)}"}

    def query_count(self, columns: list, condition: str, table_name: str,
                   start_time: Optional[str] = None, end_time: Optional[str] = None) -> Dict[str, Any]:
        try:
            csmar = self._ensure_csmar()
            count = csmar.queryCount(columns, condition, table_name, start_time, end_time)
            return {"success": True, "table": table_name, "count": int(count) if count else 0}
        except Exception as e:
            return {"success": False, "error": f"查询数量失败: {str(e)}"}

    def query(self, columns: list, condition: str, table_name: str,
             start_time: Optional[str] = None, end_time: Optional[str] = None,
             format: str = "json", limit: Optional[int] = None) -> Dict[str, Any]:
        try:
            csmar = self._ensure_csmar()
            if format == "dataframe":
                data = csmar.query_df(columns, condition, table_name, start_time, end_time)
                result = data.to_dict('records') if hasattr(data, 'to_dict') else data
            else:
                data = csmar.query(columns, condition, table_name, start_time, end_time)
                result = data

            if result is None:
                return {"success": True, "table": table_name, "data": [], "count": 0, "message": "查询结果为空"}

            if limit and isinstance(result, list):
                result = result[:limit]

            return {"success": True, "table": table_name, "data": result,
                    "count": len(result) if isinstance(result, list) else 1}
        except Exception as e:
            return {"success": False, "error": f"查询数据失败: {str(e)}"}

    def preview(self, table_name: str) -> Dict[str, Any]:
        try:
            csmar = self._ensure_csmar()
            data = csmar.preview(table_name)
            if data is None:
                return {"success": True, "table": table_name, "preview": [], "message": "预览数据为空"}
            return {"success": True, "table": table_name, "preview": data}
        except Exception as e:
            return {"success": False, "error": f"预览数据失败: {str(e)}"}


def handle_command(command: Dict[str, Any], client: CSMARClient) -> Dict[str, Any]:
    action = command.get("action")
    params = command.get("params", {})

    handlers = {
        "login": lambda: client.login(
            params.get("account", ""), params.get("pwd", ""), params.get("lang", "0")
        ),
        "list_databases": lambda: client.get_list_dbs(),
        "list_tables": lambda: client.get_list_tables(params.get("database_name", "")),
        "list_fields": lambda: client.get_list_fields(params.get("table_name", "")),
        "query_count": lambda: client.query_count(
            params.get("columns", []), params.get("condition", ""), params.get("table_name", ""),
            params.get("start_time"), params.get("end_time")
        ),
        "query": lambda: client.query(
            params.get("columns", []), params.get("condition", ""), params.get("table_name", ""),
            params.get("start_time"), params.get("end_time"), params.get("format", "json"), params.get("limit")
        ),
        "preview": lambda: client.preview(params.get("table_name", "")),
        "check_availability": lambda: {
            "success": True,
            "csmar_available": CSMAR_AVAILABLE,
            "client_logged_in": client.logged_in,
            "username": client.username,
            "sdk_error": _sdk_error if not CSMAR_AVAILABLE else None
        },
        "reset": lambda: client.reset() or {"success": True, "message": "已重置"}
    }

    handler = handlers.get(action)
    if handler:
        return handler()

    return {"success": False, "error": f"未知动作: {action}", "supported_actions": list(handlers.keys())}


def main():
    parser = argparse.ArgumentParser(description="CSMAR Python Client")
    parser.add_argument("--once", action="store_true", help="单次调用模式")
    args = parser.parse_args()

    client = CSMARClient()

    if args.once:
        try:
            input_data = sys.stdin.read()
            command = json.loads(input_data)
            result = handle_command(command, client)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        except json.JSONDecodeError as e:
            print(json.dumps({"success": False, "error": f"JSON解析错误: {str(e)}"}, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
    else:
        logger.info("CSMAR Client 启动 (持久化模式)")
        sys.stdout.write(json.dumps({"type": "ready", "csmar_available": CSMAR_AVAILABLE}) + "\n")
        sys.stdout.flush()

        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                command = json.loads(line.strip())
                result = handle_command(command, client)
                print(json.dumps(result, ensure_ascii=False, indent=2))
                sys.stdout.flush()
            except json.JSONDecodeError:
                print(json.dumps({"success": False, "error": "JSON解析错误"}, ensure_ascii=False))
                sys.stdout.flush()
            except KeyboardInterrupt:
                break
            except Exception as e:
                print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
                sys.stdout.flush()


if __name__ == "__main__":
    main()
