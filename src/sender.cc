#include <node.h>
#include <sender.h>
#include <questdb/ilp/line_sender.h>
#include <iostream>

namespace questdb {

using namespace v8;

Sender::Sender() {
}

Sender::~Sender() {
}

// assumes that 'value' is either a Number or a BigInt, caller has to check before the call
int64_t extract_int(Local<Value> value) {
    int64_t x;
	if (value->IsNumber()) {
        x = value.As<Number>()->Value();
    } else {
        x = value.As<BigInt>()->Int64Value();
    }
    return x;
}

void Sender::HandleErr(Isolate* isolate, const Sender* instance) {
    size_t err_len = 0;
    const char* err_msg = line_sender_error_msg(instance->err, &err_len);

    isolate->ThrowException(Exception::TypeError(String::NewFromUtf8(isolate, err_msg, NewStringType::kNormal, err_len).ToLocalChecked()));

    line_sender_opts_free(instance->opts);
    line_sender_error_free(instance->err);
    line_sender_buffer_free(instance->buffer);
    line_sender_close(instance->sender);
}

bool Sender::DoConnect(Isolate* isolate, Sender* instance, const char* host, const int port) {
    line_sender_utf8 host_utf8 = { 0, NULL };
    if (!line_sender_utf8_init(&host_utf8, strlen(host), host, &(instance->err))) {
        HandleErr(isolate, instance);
        return false;
    }

    instance->opts = line_sender_opts_new(host_utf8, port);
    instance->sender = line_sender_connect(instance->opts, &(instance->err));
    line_sender_opts_free(instance->opts);
    instance->opts = NULL;
    if (!instance->sender) {
        return false;
    }

    instance->buffer = line_sender_buffer_new();
    line_sender_buffer_reserve(instance->buffer, 64 * 1024);
    return true;
}

void Sender::DoAddFloat64(Isolate* isolate, Sender* instance, const char* column, const double value) {
    line_sender_column_name column_utf8 = { 0, NULL };
    if (!line_sender_column_name_init(&column_utf8, strlen(column), column, &(instance->err))) {
        HandleErr(isolate, instance);
    }

    if (!line_sender_buffer_column_f64(instance->buffer, column_utf8, value, &(instance->err))) {
        HandleErr(isolate, instance);
    }
}

void Sender::DoAddInt64(Isolate* isolate, Sender* instance, const char* column, const int64_t value) {
    line_sender_column_name column_utf8 = { 0, NULL };
    if (!line_sender_column_name_init(&column_utf8, strlen(column), column, &(instance->err))) {
        HandleErr(isolate, instance);
    }

    if (!line_sender_buffer_column_i64(instance->buffer, column_utf8, value, &(instance->err))) {
        HandleErr(isolate, instance);
    }
}

void Sender::DoAddTimestamp(Isolate* isolate, Sender* instance, const char* column, const int64_t micros) {
    line_sender_column_name column_utf8 = { 0, NULL };
    if (!line_sender_column_name_init(&column_utf8, strlen(column), column, &(instance->err))) {
        HandleErr(isolate, instance);
    }

    if (!line_sender_buffer_column_ts(instance->buffer, column_utf8, micros, &(instance->err))) {
        HandleErr(isolate, instance);
    }
}

void Sender::DoAddBool(Isolate* isolate, Sender* instance, const char* column, const bool value) {
    line_sender_column_name column_utf8 = { 0, NULL };
    if (!line_sender_column_name_init(&column_utf8, strlen(column), column, &(instance->err))) {
        HandleErr(isolate, instance);
    }

    if (!line_sender_buffer_column_bool(instance->buffer, column_utf8, value, &(instance->err))) {
        HandleErr(isolate, instance);
    }
}

void Sender::DoAddString(Isolate* isolate, Sender* instance, const char* column, const char* value) {
    line_sender_column_name column_utf8 = { 0, NULL };
    if (!line_sender_column_name_init(&column_utf8, strlen(column), column, &(instance->err))) {
        HandleErr(isolate, instance);
    }

    line_sender_utf8 value_utf8 = { 0, NULL };
    if (!line_sender_utf8_init(&value_utf8, strlen(value), value, &(instance->err))) {
        HandleErr(isolate, instance);
    }

    if (!line_sender_buffer_column_str(instance->buffer, column_utf8, value_utf8, &(instance->err))) {
        HandleErr(isolate, instance);
    }
}

void Sender::DoAddSymbol(Isolate* isolate, Sender* instance, const char* symbol, const char* value) {
    line_sender_column_name symbol_utf8 = { 0, NULL };
    if (!line_sender_column_name_init(&symbol_utf8, strlen(symbol), symbol, &(instance->err))) {
        HandleErr(isolate, instance);
    }

    line_sender_utf8 value_utf8 = { 0, NULL };
    if (!line_sender_utf8_init(&value_utf8, strlen(value), value, &(instance->err))) {
        HandleErr(isolate, instance);
    }

    if (!line_sender_buffer_symbol(instance->buffer, symbol_utf8, value_utf8, &(instance->err))) {
        HandleErr(isolate, instance);
    }
}

void Sender::DoSetTable(Isolate* isolate, Sender* instance, const char* table) {
    line_sender_table_name table_name = { 0, NULL };
    if (!line_sender_table_name_init(&table_name, strlen(table), table, &(instance->err))) {
        HandleErr(isolate, instance);
    }

    if (!line_sender_buffer_table(instance->buffer, table_name, &(instance->err))) {
        HandleErr(isolate, instance);
    }
}

void Sender::AddSymbol(const FunctionCallbackInfo<Value>& args) {
	Isolate* isolate = args.GetIsolate();

	if (args.Length() < 2) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Wrong number of arguments, symbol name and value expected")));
        return;
    }

	if (!args[0]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "First argument (symbol name) should be a string")));
        return;
    }
    const String::Utf8Value symbol(isolate, args[0]);

	if (!args[1]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Second argument (symbol value) should be a string")));
        return;
    }
    const String::Utf8Value value(isolate, args[1]);

    const Local<Object> holder = args.Holder();
    Sender* instance = ObjectWrap::Unwrap<Sender>(holder);
    DoAddSymbol(isolate, instance, *symbol, *value);
	args.GetReturnValue().Set(holder);
    std::cout << "symbol=" << *symbol << ", value=" << *value << std::endl;
}

void Sender::AddString(const FunctionCallbackInfo<Value>& args) {
	Isolate* isolate = args.GetIsolate();

	if (args.Length() < 2) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Wrong number of arguments, column name and value expected")));
        return;
    }

	if (!args[0]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "First argument (column name) should be a string")));
        return;
    }
    const String::Utf8Value column(isolate, args[0]);

	if (!args[1]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Second argument (string value) should be a string")));
        return;
    }
    const String::Utf8Value value(isolate, args[1]);

    const Local<Object> holder = args.Holder();
    Sender* instance = ObjectWrap::Unwrap<Sender>(holder);
    DoAddString(isolate, instance, *column, *value);
	args.GetReturnValue().Set(holder);
    std::cout << "column=" << *column << ", value=" << *value << std::endl;
}

void Sender::AddBool(const FunctionCallbackInfo<Value>& args) {
	Isolate* isolate = args.GetIsolate();

	if (args.Length() < 2) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Wrong number of arguments, column name and value expected")));
        return;
    }

	if (!args[0]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "First argument (column name) should be a string")));
        return;
    }
    const String::Utf8Value column(isolate, args[0]);

	if (!args[1]->IsBoolean()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Second argument (boolean value) should be a boolean")));
        return;
    }
    const bool value = args[1].As<Boolean>()->Value();

    const Local<Object> holder = args.Holder();
    Sender* instance = ObjectWrap::Unwrap<Sender>(holder);
    DoAddBool(isolate, instance, *column, value);
	args.GetReturnValue().Set(holder);
    std::cout << "column=" << *column << ", value=" << value << std::endl;
}

void Sender::AddFloat64(const FunctionCallbackInfo<Value>& args) {
	Isolate* isolate = args.GetIsolate();

	if (args.Length() < 2) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Wrong number of arguments, column name and value expected")));
        return;
    }

	if (!args[0]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "First argument (column name) should be a string")));
        return;
    }
    const String::Utf8Value column(isolate, args[0]);

	if (!args[1]->IsNumber()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Second argument (float64 value) should be a number")));
        return;
    }
    const double value = args[1].As<Number>()->Value();

    const Local<Object> holder = args.Holder();
    Sender* instance = ObjectWrap::Unwrap<Sender>(holder);
    DoAddFloat64(isolate, instance, *column, value);
	args.GetReturnValue().Set(holder);
    std::cout << "column=" << *column << ", value=" << value << std::endl;
}

void Sender::AddInt64(const FunctionCallbackInfo<Value>& args) {
	Isolate* isolate = args.GetIsolate();

	if (args.Length() < 2) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Wrong number of arguments, column name and value expected")));
        return;
    }

	if (!args[0]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "First argument (column name) should be a string")));
        return;
    }
    const String::Utf8Value column(isolate, args[0]);

	if (!args[1]->IsNumber() && !args[1]->IsBigInt()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Second argument (int64 value) should be an integer")));
        return;
    }
    const int64_t value = extract_int(args[1]);

    const Local<Object> holder = args.Holder();
    Sender* instance = ObjectWrap::Unwrap<Sender>(holder);
    DoAddInt64(isolate, instance, *column, value);
	args.GetReturnValue().Set(holder);
    std::cout << "column=" << *column << ", value=" << value << std::endl;
}

void Sender::AddTimestamp(const FunctionCallbackInfo<Value>& args) {
	Isolate* isolate = args.GetIsolate();

	if (args.Length() < 2) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Wrong number of arguments, column name and value expected")));
        return;
    }

	if (!args[0]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "First argument (column name) should be a string")));
        return;
    }
    const String::Utf8Value column(isolate, args[0]);

	if (!args[1]->IsNumber() && !args[1]->IsBigInt()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Second argument (timestamp value) should be an integer")));
        return;
    }
    const int64_t micros = extract_int(args[1]);

    const Local<Object> holder = args.Holder();
    Sender* instance = ObjectWrap::Unwrap<Sender>(holder);
    DoAddTimestamp(isolate, instance, *column, micros);
	args.GetReturnValue().Set(holder);
    std::cout << "column=" << *column << ", micros=" << micros << std::endl;
}

void Sender::SetTable(const FunctionCallbackInfo<Value>& args) {
	Isolate* isolate = args.GetIsolate();

	if (args.Length() < 1) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Wrong number of arguments, table name expected")));
        return;
    }

	if (!args[0]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "First argument (table name) should be a string")));
        return;
    }
    const String::Utf8Value table(isolate, args[0]);

    const Local<Object> holder = args.Holder();
    Sender* instance = ObjectWrap::Unwrap<Sender>(holder);
    DoSetTable(isolate, instance, *table);
	args.GetReturnValue().Set(holder);
    std::cout << "table=" << *table << std::endl;
}

void Sender::Connect(const FunctionCallbackInfo<Value>& args) {
	Isolate* isolate = args.GetIsolate();

	if (args.Length() < 2) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Wrong number of arguments, host and port expected")));
        return;
    }

	if (!args[0]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "First argument (host) should be a string")));
        return;
    }
    const String::Utf8Value host(isolate, args[0]);

	if (!args[1]->IsNumber()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Second argument (port) should be an integer")));
        return;
    }
    const int port = args[1].As<Number>()->Value();
    std::cout << "host=" << *host << ", port=" << port << std::endl;

    const Local<Object> holder = args.Holder();
    Sender* instance = ObjectWrap::Unwrap<Sender>(holder);
    const bool connected = DoConnect(isolate, instance, *host, port);

	const Local<Boolean> output = Boolean::New(isolate, connected);
	args.GetReturnValue().Set(output);
}

void Sender::At(const FunctionCallbackInfo<Value>& args) {
	Isolate* isolate = args.GetIsolate();

	if (args.Length() < 1) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Wrong number of arguments, timestamp value expected")));
        return;
    }

	if (!args[0]->IsNumber() && !args[0]->IsBigInt()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "First argument (timestamp value) should be an integer")));
        return;
    }
    const int64_t nanos = extract_int(args[0]);

    Sender* instance = ObjectWrap::Unwrap<Sender>(args.Holder());
    if (!line_sender_buffer_at(instance->buffer, nanos, &(instance->err))) {
        HandleErr(isolate, instance);
    }
}

void Sender::AtNow(const FunctionCallbackInfo<Value>& args) {
	Isolate* isolate = args.GetIsolate();

    Sender* instance = ObjectWrap::Unwrap<Sender>(args.Holder());
    if (!line_sender_buffer_at_now(instance->buffer, &(instance->err))) {
        HandleErr(isolate, instance);
    }
    std::cout << "atNow" << std::endl;
}

void Sender::Flush(const FunctionCallbackInfo<Value>& args) {
	Isolate* isolate = args.GetIsolate();

    Sender* instance = ObjectWrap::Unwrap<Sender>(args.Holder());
    if (!line_sender_flush(instance->sender, instance->buffer, &(instance->err))) {
        HandleErr(isolate, instance);
    }
    std::cout << "sender flushed" << std::endl;
}

void Sender::Close(const FunctionCallbackInfo<Value>& args) {
    Sender* instance = ObjectWrap::Unwrap<Sender>(args.Holder());
    line_sender_close(instance->sender);
    std::cout << "sender closed" << std::endl;
}

void Sender::Init(Local<Object> exports) {
    Isolate* isolate = exports->GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();

    Local<ObjectTemplate> object_tpl = ObjectTemplate::New(isolate);
    object_tpl->SetInternalFieldCount(1);  // 1 field for Sender::New()
    Local<Object> clazz = object_tpl->NewInstance(context).ToLocalChecked();

    // Prepare constructor template
    Local<FunctionTemplate> function_tpl = FunctionTemplate::New(isolate, New, clazz);
    function_tpl->SetClassName(String::NewFromUtf8Literal(isolate, "Sender"));
    function_tpl->InstanceTemplate()->SetInternalFieldCount(1);

    // Javascript prototype
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "connect", Connect);
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "close", Close);
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "flush", Flush);
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "at", At);
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "atNow", AtNow);
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "table", SetTable);
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "symbol", AddSymbol);
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "string", AddString);
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "boolean", AddBool);
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "timestamp", AddTimestamp);
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "int64", AddInt64);
    NODE_SET_PROTOTYPE_METHOD(function_tpl, "float64", AddFloat64);

    Local<Function> constructor = function_tpl->GetFunction(context).ToLocalChecked();
    clazz->SetInternalField(0, constructor);
    exports->Set(context, String::NewFromUtf8Literal(isolate, "Sender"), constructor).FromJust();
}

void Sender::New(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();

    if (args.IsConstructCall()) {
        // Invoked as constructor: `new Sender(...)`
        Sender* instance = new Sender();
        instance->Wrap(args.This());
        args.GetReturnValue().Set(args.This());
    } else {
        // Invoked as plain function `Sender(...)`, turn into construct call.
        Local<Function> cons = args.Data().As<Object>()->GetInternalField(0).As<Function>();
        Local<Object> result = cons->NewInstance(context).ToLocalChecked();
        args.GetReturnValue().Set(result);
    }
}

}  // namespace questdb
