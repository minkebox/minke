FROM alpine:latest

COPY app/ /app
COPY startup.sh /startup.sh
COPY etc/ /etc

RUN apk add nodejs \
    npm \
    dnsmasq tzdata openntpd e2fsprogs parted dnscrypt-proxy ;\
    cd /app ; npm install --production ;\
    apk del npm ;\
    mkdir -p /etc/dnshosts.d

EXPOSE 53/tcp 53/udp 80/tcp
VOLUME /minke/db /minke/apps /app/skeletons/local /app/skeletons/internal

LABEL net.minkebox.system="true"

ENTRYPOINT ["/startup.sh"]
