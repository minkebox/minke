FROM alpine:latest

COPY app/ /app
COPY startup.sh /startup.sh

RUN apk add nodejs nodejs-npm dnsmasq tzdata openntpd e2fsprogs parted ;\
    cd /app ; npm install ;\
    apk --no-cache del nodejs-npm ;\
    mkdir -p /etc/dnshosts.d

COPY etc/ /etc

EXPOSE 53/tcp 53/udp 80/tcp
VOLUME /minke/db /minke/apps /app/skeletons/local

ENTRYPOINT ["/startup.sh"]
 
