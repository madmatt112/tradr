# CI-ONLY nginx probe location for the streaming liveness smoke test
# (deployment task 12, Req 8.4). This file is NOT in the shipped web image: the
# Dockerfile does not copy it. The CI overlay (docker-compose.ci.yml) bind-mounts
# it into /etc/nginx/conf.d/probe/_probe.conf, where the shipped default.conf's
# `include /etc/nginx/conf.d/probe/*.conf;` (empty/missing glob in prod) picks it
# up. It proxies to the `sse-stub` compose service by DNS name.
#
# This is a POSITIVE-ONLY liveness probe: it proves the SSE proxy path delivers
# frames incrementally end-to-end through the shipped stream-proxy.inc snippet. It
# is NOT a negative control and does not prove buffering is disabled — that is the
# job of the static `nginx -T` assertions in the docker-smoke job (a directive
# assertion that stream-proxy.inc contains `proxy_buffering off;`, and a no-strip
# assertion for the upstream X-Accel-Buffering header). The probe location
# includes the byte-identical conf.d/stream-proxy.inc the shipped stream location
# uses, so the liveness path exercises the same directives.
location /_probe/stream {
    proxy_pass http://sse-stub:8080;
    include conf.d/stream-proxy.inc;
}
