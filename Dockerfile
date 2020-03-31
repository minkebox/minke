FROM alpine:3.11

EXPOSE 53/tcp 53/udp 80/tcp
VOLUME /minke

LABEL net.minkebox.system="true"

ENTRYPOINT ["/startup.sh"]

COPY startup.sh /startup.sh
COPY app/package.json /app/package.json
RUN apk add nodejs npm \
    dnsmasq tzdata openntpd e2fsprogs parted dnscrypt-proxy ;\
    mkdir -p /etc/dnshosts.d/h /etc/dnshosts.d/g ;\
    cd /app ; npm install --production ; apk del npm

COPY app/ /app
