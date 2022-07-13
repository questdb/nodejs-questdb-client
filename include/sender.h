#ifndef SENDER_H
#define SENDER_H

#include <node.h>
#include <node_object_wrap.h>
#include <questdb/ilp/line_sender.h>

namespace questdb {

using namespace v8;

class Sender : public node::ObjectWrap {
    public:
        static void Init(Local<Object> exports);

    private:
        Sender();
        ~Sender();

        static void New(const FunctionCallbackInfo<Value>& args);
        static void Close(const FunctionCallbackInfo<Value>& args);
        static void Flush(const FunctionCallbackInfo<Value>& args);
        static void Connect(const FunctionCallbackInfo<Value>& args);
        static bool DoConnect(Isolate* isolate, Sender* instance, const char* host, const int port);
        static void SetTable(const FunctionCallbackInfo<Value>& args);
        static void DoSetTable(Isolate* isolate, Sender* instance, const char* table);
        static void AddSymbol(const FunctionCallbackInfo<Value>& args);
        static void DoAddSymbol(Isolate* isolate, Sender* instance, const char* symbol, const char* value);
        static void AddString(const FunctionCallbackInfo<Value>& args);
        static void DoAddString(Isolate* isolate, Sender* instance, const char* column, const char* value);
        static void AddTimestamp(const FunctionCallbackInfo<Value>& args);
        static void DoAddTimestamp(Isolate* isolate, Sender* instance, const char* column, const int64_t micros);
        static void AddInt64(const FunctionCallbackInfo<Value>& args);
        static void DoAddInt64(Isolate* isolate, Sender* instance, const char* column, const int64_t value);
        static void AddFloat64(const FunctionCallbackInfo<Value>& args);
        static void DoAddFloat64(Isolate* isolate, Sender* instance, const char* column, const double value);
        static void AddBool(const FunctionCallbackInfo<Value>& args);
        static void DoAddBool(Isolate* isolate, Sender* instance, const char* column, const bool value);
        static void At(const FunctionCallbackInfo<Value>& args);
        static void AtNow(const FunctionCallbackInfo<Value>& args);
        static void HandleErr(Isolate* isolate, const Sender* instance);

        line_sender_error* err = NULL;
        line_sender_opts* opts = NULL;
        line_sender* sender = NULL;
        line_sender_buffer* buffer = NULL;
};

}  // namespace questdb

#endif
