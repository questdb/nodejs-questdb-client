/** One replayable ingress frame. */
export interface QwpIngressReplayRecord {
  readonly frameSequence: bigint;
  readonly payload: Uint8Array;
}

/** Lightweight durable-frame descriptor used by disk-backed replay stores. */
export interface QwpIngressReplayReference {
  readonly frameSequence: bigint;
  readonly payloadLength: number;
}

/**
 * Where a reconnecting ingress connection keeps frames until they are
 * acknowledged: the built-in memory queue, or the Node store-and-forward
 * journal. Browser-safe; Node supplies the persistent filesystem
 * implementation.
 *
 * Internal, like the two types above: neither package root exports them.
 * Applications configure the one persistent store through the ingress
 * options' `storeAndForward` rather than plugging in an implementation.
 */
export interface QwpIngressReplayStore {
  load(): Promise<readonly QwpIngressReplayRecord[]>;
  /**
   * Opens and validates the journal without materializing every payload.
   * Implementations that provide this must also provide `readPayload`.
   */
  loadReferences?(): Promise<readonly QwpIngressReplayReference[]>;
  /** Reads one previously loaded durable payload on demand. */
  readPayload?(frameSequence: bigint): Promise<Uint8Array>;
  /**
   * Waits until every payload in one logical batch can be appended without an
   * ACK between frames. Implementations must not mutate the journal.
   */
  prepareAppendBatch?(payloads: readonly Uint8Array[]): Promise<void>;
  append(record: QwpIngressReplayRecord): Promise<void>;
  acknowledgeThrough(frameSequence: bigint): Promise<void>;
  /**
   * Removes a local prefix without representing it as a server ACK.
   * Persistent stores should provide this when recovery can abandon frames.
   *
   * "Without representing it as a server ACK" is about the transport's public
   * watermark, which the caller leaves alone. The removal itself must be as
   * durable as `acknowledgeThrough`'s: a discarded prefix that a later `load()`
   * can still see is a prefix this client reported abandoned and then sent
   * anyway.
   */
  discardThrough?(frameSequence: bigint): Promise<void>;
  /** Loads the durable, dense symbol prefix used by persisted delta frames. */
  loadSymbolDictionary?(): Promise<readonly string[]>;
  /** Persists new dense entries before a delta frame is made replayable. */
  appendSymbolDictionary?(
    startId: number,
    entries: readonly string[],
  ): Promise<void>;
  /**
   * Atomically replaces an unusable dictionary after surviving committed
   * frames prove that its complete ID space can be reconstructed.
   */
  replaceSymbolDictionary?(entries: readonly string[]): Promise<void>;
  close(): Promise<void>;
}
