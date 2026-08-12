"""gunicorn 入口。

启动：.venv/bin/gunicorn --workers 1 --threads 8 --bind 127.0.0.1:8000 wsgi:app
注意：必须保持 --workers 1，上传队列运行在进程内。
"""

from app import app, init_runtime, validate_config

config_error = validate_config()
if config_error:
    raise SystemExit(f"配置错误: {config_error}")

init_runtime()
