const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get;

export function isUint8Array(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    TYPED_ARRAY_TAG_GETTER?.call(value) === "Uint8Array"
  );
}

export function isInt8Array(value: unknown): value is Int8Array {
  return (
    ArrayBuffer.isView(value) &&
    TYPED_ARRAY_TAG_GETTER?.call(value) === "Int8Array"
  );
}
