#include <node.h>
#include <sender.h>

namespace questdb {

using namespace v8;

void Initialize(Local<Object> exports) {
    Sender::Init(exports);
}

NODE_MODULE(questdbclient, Initialize)

}  // namespace questdb
