# Shared SSE streaming directives.
#
# Included by the shipped stream location (docker/nginx.conf.template) and the
# CI-only probe location (docker/conf.d/_probe.inc) so both exercise the
# identical, byte-for-byte buffering-off directives.
#
# Only the response is unbuffered. There is intentionally NO
# `proxy_request_buffering off`: the request is a bounded JSON body the handler
# fully parses before it begins streaming (design C3 / Req 4.2).
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_buffering off;
proxy_cache off;
gzip off;
proxy_set_header Accept-Encoding "";
chunked_transfer_encoding on;
proxy_read_timeout ${ADVISOR_NGINX_PROXY_TIMEOUT};
proxy_send_timeout ${ADVISOR_NGINX_PROXY_TIMEOUT};
