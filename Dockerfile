FROM alpine:latest

COPY app/ /app
COPY startup.sh /startup.sh

RUN apk --no-cache add nodejs nodejs-npm dnsmasq tzdata openntpd ;\
    cd /app ; npm install ;\
    apk --no-cache del nodejs-npm ;\
    mkdir -p /etc/dnsmasq.d /etc/dnshosts.d

COPY etc/ /etc

EXPOSE 53/tcp 53/udp 80/tcp
VOLUME /minke/db /minke/apps /app/skeletons/local

ENTRYPOINT ["/startup.sh"]
 
