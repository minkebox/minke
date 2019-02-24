FROM alpine:edge

COPY app/ /app
COPY etc/ /etc
COPY startup.sh /startup.sh

RUN apk --no-cache add nodejs nodejs-npm dnsmasq tzdata openntpd; \
    cd /app ; npm install ; \
    apk --no-cache del nodejs-npm

EXPOSE 53/tcp 53/udp 80/tcp
VOLUME /minke/db /minke/fs /app/skeletons/local

ENTRYPOINT ["/startup.sh"]
 
