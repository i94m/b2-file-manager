"""gunicorn 入口（Flask-SocketIO，threaded worker + simple-websocket）。

启动：.venv/bin/gunicorn --workers 1 --threads 8 --bind 127.0.0.1:8000 wsgi:app
注意：必须保持 --workers 1，上传队列与 WebSocket 广播都运行在同一进程内。
"""

from app import app, init_runtime, validate_config

config_error = validate_config()
if config_error:
    raise SystemExit(f"配置错误: {config_error}")

init_runtime()
# 说明：SocketIO(app) 已把 Flask 应用的 wsgi_app 包装为 SocketIO 中间件，
# gunicorn 直接加载 wsgi:app（Flask 应用）即可同时处理 HTTP 与 WebSocket。
