#include <napi.h>
#include <sys/socket.h>
#include <netinet/ip.h>
#include <arpa/inet.h>


Napi::Number BindUDPIFace(const Napi::CallbackInfo& info) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  std::string iface = info[0].As<Napi::String>().Utf8Value();
  int rc = setsockopt(fd, SOL_SOCKET, SO_BINDTODEVICE, iface.c_str(), iface.length());
  if (rc < 0) {
    printf("bindtodevice %d %s error: %d\n", fd, iface.c_str(), errno);
  }
  std::string address = info[1].As<Napi::String>().Utf8Value();
  int port = info[2].As<Napi::Number>().Int32Value();
  struct sockaddr_in addr;
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  rc = inet_pton(AF_INET, address.c_str(), &addr.sin_addr.s_addr);
  if (rc < 0) {
    printf("inet_pton %d %s %s %d error: %d\n", fd, iface.c_str(), address.c_str(), port, errno);
  }
  rc = bind(fd, (struct sockaddr*)&addr, sizeof(addr));
  if (rc < 0) {
    printf("bind %d %s %s %d error: %d\n", fd, iface.c_str(), address.c_str(), port, errno);
  }
  //printf("udp %d %s %s %d\n", fd, iface.c_str(), address.c_str(), port);
  return Napi::Number::New(info.Env(), fd);
}

Napi::Number BindTCPIFace(const Napi::CallbackInfo& info) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  std::string iface = info[0].As<Napi::String>().Utf8Value();
  int rc = setsockopt(fd, SOL_SOCKET, SO_BINDTODEVICE, iface.c_str(), iface.length());
  if (rc < 0) {
    printf("bindtodevice %d %s error: %d\n", fd, iface.c_str(), errno);
  }
  std::string address = info[1].As<Napi::String>().Utf8Value();
  int port = info[2].As<Napi::Number>().Int32Value();
  struct sockaddr_in addr;
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  rc = inet_pton(AF_INET, address.c_str(), &addr.sin_addr.s_addr);
  if (rc < 0) {
    printf("inet_pton %d %s %s %d error: %d\n", fd, iface.c_str(), address.c_str(), port, errno);
  }
  rc = bind(fd, (struct sockaddr*)&addr, sizeof(addr));
  if (rc < 0) {
    printf("bind %d %s %s %d error: %d\n", fd, iface.c_str(), address.c_str(), port, errno);
  }
  //printf("tcp %d %s %s %d\n", fd, iface.c_str(), address.c_str(), port);
  return Napi::Number::New(info.Env(), fd);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "BindUDPIFace"), Napi::Function::New(env, BindUDPIFace));
  exports.Set(Napi::String::New(env, "BindTCPIFace"), Napi::Function::New(env, BindTCPIFace));
  return exports;
}

NODE_API_MODULE(native, Init)
