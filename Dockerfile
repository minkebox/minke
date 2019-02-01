FROM alpine:edge

COPY app/ /app
COPY startup.sh /startup.sh

RUN apk --no-cache add nodejs nodejs-npm dnsmasq tzdata; \
    cd /app ; npm install ; \
    apk --no-cache del nodejs-npm

EXPOSE 53/tcp 53/udp 80/tcp
VOLUME /minke

ENTRYPOINT ["/startup.sh"]
 