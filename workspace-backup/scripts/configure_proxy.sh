# 配置代理环境变量
export http_proxy="http://host.docker.internal:7890"
export https_proxy="http://host.docker.internal:7890"
export HTTP_PROXY="http://host.docker.internal:7890"
export HTTPS_PROXY="http://host.docker.internal:7890"
export no_proxy="localhost,127.0.0.1,.local"
export NO_PROXY="localhost,127.0.0.1,.local"

echo "✅ 代理已配置: host.docker.internal:7890"
