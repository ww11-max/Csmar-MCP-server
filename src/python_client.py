#!/usr/bin/env python3
"""
CSMAR Python客户端 - 用于Node.js MCP服务器调用CSMAR-PYTHON SDK
通过标准输入/输出JSON进行通信，支持持久化会话模式

用法:
    python python_client.py              # 交互模式 (持久化)
    python python_client.py --once       # 单次调用模式
"""

import sys
import json
import traceback
import logging
import os
import argparse
from typing import Dict, Any, Optional

# ==================== 自动检测 Python 路径 ====================
def setup_python_paths():
    """自动检测并设置Python路径以确保可以导入CSMAR SDK"""
    import site
    
    new_paths = []
    
    # 1. 获取 site-packages 路径
    try:
        site_packages = site.getsitepackages()
        new_paths.extend(site_packages)
    except Exception:
        pass
    
    # 2. 添加用户 site-packages
    try:
        user_site = site.getusersitepackages()
        if user_site and os.path.exists(user_site):
            new_paths.append(user_site)
    except Exception:
        pass
    
    # 3. 常见 Python 安装路径 (跨平台)
    common_paths = [
        r"D:\python\Lib\site-packages",
        r"D:\Python313\Lib\site-packages",
        r"D:\Python312\Lib\site-packages",
        r"D:\Python311\Lib\site-packages",
        r"C:\Python313\Lib\site-packages",
        r"C:\Python312\Lib\site-packages",
        r"C:\Python311\Lib\site-packages",
        r"C:\Python310\Lib\site-packages",
        r"C:\Program Files\Python313\Lib\site-packages",
        r"C:\Program Files\Python312\Lib\site-packages",
        r"C:\Program Files\Python311\Lib\site-packages",
        "/usr/local/lib/python3.13/site-packages",
        "/usr/local/lib/python3.12/site-packages",
        "/usr/local/lib/python3.11/site-packages",
        "/usr/lib/python3.13/site-packages",
        "/usr/lib/python3.12/site-packages",
        "/usr/lib/python3.11/site-packages",
        os.path.expanduser("~/.local/lib/python3.13/site-packages"),
        os.path.expanduser("~/.local/lib/python3.12/site-packages"),
        os.path.expanduser("~/.local/lib/python3.11/site-packages"),
    ]
    
    for p in common_paths:
        if os.path.exists(p) and p not in new_paths:
            new_paths.append(p)
    
    # 4. 添加 csmarapi 目录
    for sp in new_paths:
        csmarapi_dir = os.path.join(sp, "csmarapi")
        if os.path.exists(csmarapi_dir) and csmarapi_dir not in new_paths:
            new_paths.append(csmarapi_dir)
    
    # 5. 将新路径插入 sys.path 前面 (避免重复)
    existing_paths = [p for p in new_paths if os.path.exists(p)]
    original_paths = [p for p in sys.path if p not in existing_paths]
    sys.path = existing_paths + original_paths
    
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
    logger.info(f"已添加路径: {added_paths}")

# ==================== 导入 CSMAR SDK ====================
CSMAR_AVAILABLE = False
CsmarService = None
ReportUtil = None

try:
    from csmarapi.CsmarService import CsmarService
    from csmarapi.ReportUtil import ReportUtil
    CSMAR_AVAILABLE = True
    logger.info("CSMAR SDK 导入成功")
except ImportError as e:
    logger.warning(f"无法导入 CSMAR SDK: {e}")
    logger.info("请确保已安装 CSMAR-PYTHON SDK:")
    logger.info("  1. 下载 CSMAR-PYTHON 压缩包")
    logger.info("  2. 解压到 Python 的 site-packages 目录")
    logger.info("  3. 安装依赖: pip install urllib3 websocket_client pandas prettytable")


class CSMARClient:
    """CSMAR客户端 - 复用会话实例"""
    
    # 类级别的持久化实例
    _instance = None
    _csmar = None
    _logged_in = False
    _username = None
    
    def __new__(cls):
        """单例模式 - 保持实例持久化"""
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
        
        # 设置工作目录到项目根目录
        try:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            project_root = os.path.abspath(os.path.join(script_dir, ".."))
            if os.path.exists(project_root):
                os.chdir(project_root)
                
                # 检查 token.txt 是否存在
                token_path = os.path.join(project_root, "token.txt")
                if os.path.exists(token_path):
                    self.logged_in = True
                    logger.info(f"找到 token.txt，假设已登录")
        except Exception as e:
            logger.error(f"设置工作目录失败: {e}")
    
    def _ensure_csmar(self):
        """确保 csmar 实例存在"""
        if not self.csmar:
            if not CSMAR_AVAILABLE:
                raise RuntimeError("CSMAR SDK 未安装")
            self.csmar = CsmarService()
        return self.csmar
    
    def reset(self):
        """重置客户端状态 (用于持久化模式下的重新初始化)"""
        self.csmar = None
        self.logged_in = False
        self.username = None
        
        # 重新检查 token
        try:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            project_root = os.path.abspath(os.path.join(script_dir, ".."))
            token_path = os.path.join(project_root, "token.txt")
            if os.path.exists(token_path):
                self.logged_in = True
        except Exception:
            pass
        
        return self
    
    def login(self, account: str, pwd: str, lang: str = "0") -> Dict[str, Any]:
        """登录 CSMAR 账户"""
        try:
            if not CSMAR_AVAILABLE:
                return {
                    "success": False,
                    "error": "CSMAR SDK 未安装",
                    "detail": "请安装 CSMAR-PYTHON SDK"
                }
            
            self.csmar = CsmarService()
            lang_code = 0 if lang == "1" else 1  # 修正: 0=中文, 1=英文
            result = self.csmar.login(account, pwd, lang_code)
            
            if result is None:
                # 尝试验证登录
                try:
                    test_dbs = self.csmar.getListDbs()
                    if test_dbs is not None:
                        self.logged_in = True
                        self.username = account
                        return {"success": True, "message": "登录成功", "username": account}
                except Exception:
                    pass
                return {"success": False, "error": "登录验证失败"}
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
            return {"success": False, "error": f"登录异常: {str(e)}", "traceback": traceback.format_exc()}
    
    def get_list_dbs(self) -> Dict[str, Any]:
        """获取数据库列表"""
        try:
            csmar = self._ensure_csmar()
            databases = csmar.getListDbs()
            
            if databases is None:
                return {"success": False, "error": "数据库列表为空", "databases": [], "count": 0}
            
            db_list = list(databases) if hasattr(databases, '__iter__') else [str(databases)]
            return {"success": True, "databases": db_list, "count": len(db_list)}
            
        except Exception as e:
            return {"success": False, "error": f"获取数据库列表失败: {str(e)}", "traceback": traceback.format_exc()}
    
    def get_list_tables(self, database_name: str) -> Dict[str, Any]:
        """获取指定数据库的表列表"""
        try:
            csmar = self._ensure_csmar()
            
            # 尝试匹配数据库名称
            try:
                databases = csmar.getListDbs()
                if databases:
                    for db in databases:
                        if isinstance(db, dict):
                            db_name = db.get('databaseName', '')
                            if db_name and db_name.strip() == database_name.strip():
                                database_name = db_name
                                break
            except Exception:
                pass
            
            tables = csmar.getListTables(database_name)
            
            if tables is None:
                return {"success": False, "error": f"表列表为空", "database": database_name, "tables": [], "count": 0}
            
            table_list = list(tables) if hasattr(tables, '__iter__') else [str(tables)]
            return {"success": True, "database": database_name, "tables": table_list, "count": len(table_list)}
            
        except Exception as e:
            return {"success": False, "error": f"获取表列表失败: {str(e)}", "traceback": traceback.format_exc()}
    
    def get_list_fields(self, table_name: str) -> Dict[str, Any]:
        """获取指定表的字段列表"""
        try:
            csmar = self._ensure_csmar()
            fields = csmar.getListFields(table_name)
            
            if fields is None:
                return {"success": False, "error": "字段列表为空", "table": table_name, "fields": [], "count": 0}
            
            field_list = list(fields) if hasattr(fields, '__iter__') else [str(fields)]
            return {"success": True, "table": table_name, "fields": field_list, "count": len(field_list)}
            
        except Exception as e:
            return {"success": False, "error": f"获取字段列表失败: {str(e)}", "traceback": traceback.format_exc()}
    
    def query_count(self, columns: list, condition: str, table_name: str,
                   start_time: Optional[str] = None, end_time: Optional[str] = None) -> Dict[str, Any]:
        """查询记录数量"""
        try:
            csmar = self._ensure_csmar()
            count = csmar.queryCount(columns, condition, table_name, start_time, end_time)
            return {"success": True, "table": table_name, "count": int(count) if count else 0}
        except Exception as e:
            return {"success": False, "error": f"查询数量失败: {str(e)}", "traceback": traceback.format_exc()}
    
    def query(self, columns: list, condition: str, table_name: str,
             start_time: Optional[str] = None, end_time: Optional[str] = None,
             format: str = "json", limit: Optional[int] = None) -> Dict[str, Any]:
        """查询数据"""
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
            
            return {"success": True, "table": table_name, "data": result, "count": len(result) if isinstance(result, list) else 1}
            
        except Exception as e:
            return {"success": False, "error": f"查询数据失败: {str(e)}", "traceback": traceback.format_exc()}
    
    def preview(self, table_name: str) -> Dict[str, Any]:
        """预览表数据"""
        try:
            csmar = self._ensure_csmar()
            data = csmar.preview(table_name)
            
            if data is None:
                return {"success": True, "table": table_name, "preview": [], "message": "预览数据为空"}
            
            return {"success": True, "table": table_name, "preview": data}
            
        except Exception as e:
            return {"success": False, "error": f"预览数据失败: {str(e)}", "traceback": traceback.format_exc()}


def handle_command(command: Dict[str, Any], client: CSMARClient) -> Dict[str, Any]:
    """处理命令"""
    action = command.get("action")
    params = command.get("params", {})
    
    handlers = {
        "login": lambda: client.login(params.get("account"), params.get("pwd"), params.get("lang", "0")),
        "list_databases": lambda: client.get_list_dbs(),
        "list_tables": lambda: client.get_list_tables(params.get("database_name")),
        "list_fields": lambda: client.get_list_fields(params.get("table_name")),
        "query_count": lambda: client.query_count(
            params.get("columns", []), params.get("condition", ""), params.get("table_name"),
            params.get("start_time"), params.get("end_time")
        ),
        "query": lambda: client.query(
            params.get("columns", []), params.get("condition", ""), params.get("table_name"),
            params.get("start_time"), params.get("end_time"), params.get("format", "json"), params.get("limit")
        ),
        "preview": lambda: client.preview(params.get("table_name")),
        "check_availability": lambda: {
            "success": True,
            "csmar_available": CSMAR_AVAILABLE,
            "client_logged_in": client.logged_in,
            "username": client.username
        },
        "reset": lambda: client.reset() or {"success": True, "message": "已重置"}
    }
    
    handler = handlers.get(action)
    if handler:
        return handler()
    
    return {"success": False, "error": f"未知动作: {action}", "supported_actions": list(handlers.keys())}


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description="CSMAR Python Client")
    parser.add_argument("--once", action="store_true", help="单次调用模式")
    args = parser.parse_args()
    
    # 创建客户端 (单例)
    client = CSMARClient()
    
    if args.once:
        # 单次调用模式
        try:
            input_data = sys.stdin.read()
            command = json.loads(input_data)
            result = handle_command(command, client)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False, indent=2))
    else:
        # 持久化交互模式
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
                
            except json.JSONDecodeError as e:
                print(json.dumps({"success": False, "error": f"JSON解析错误: {str(e)}"}, ensure_ascii=False, indent=2))
                sys.stdout.flush()
            except KeyboardInterrupt:
                break
            except Exception as e:
                print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False, indent=2))
                sys.stdout.flush()


if __name__ == "__main__":
    main()
