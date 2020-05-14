#include <napi.h>
#include <sys/socket.h>

void BindIFaceSocket(const Napi::CallbackInfo& info) {
  int fd = info[0].As<Napi::Number>().Int32Value();
  std::string iface = info[1].As<Napi::String>().Utf8Value();
  int rc = setsockopt(fd, SOL_SOCKET, SO_BINDTODEVICE, iface.c_str(), iface.length());
  if (rc < 0) {
    printf("bindtodevice %d %s error: %d\n", fd, iface.c_str(), errno);
  }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "BindIFaceSocket"),  Napi::Function::New(env, BindIFaceSocket));
  return exports;
}

NODE_API_MODULE(native, Init)
