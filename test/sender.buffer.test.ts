// @ts-check
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

import { Sender, SenderOptions } from "../src";
import { PROTOCOL_VERSION_V3 } from "../src/options";

type Column = { name: string } & (
  | { type: "STRING"; value: string }
  | { type: "LONG"; value: number }
  | { type: "DOUBLE"; value: number }
  | { type: "BOOLEAN"; value: boolean }
  | { type: "TIMESTAMP"; value: number | bigint }
  | { type: "DECIMAL"; value: string }
);

interface TestCase {
  testName: string;
  table: string;
  symbols: Array<{ name: string; value: string }>;
  columns: Array<Column>;
  result: {
    status: string;
    line?: string;
    anyLines?: Array<string>;
    binaryBase64?: string;
  };
}

describe("Client interop test suite", function () {
  it("runs client tests as per json test config", async function () {
    const testCases = JSON.parse(
      readFileSync(
        "./questdb-client-test/ilp-client-interop-test.json",
      ).toString(),
    ) as TestCase[];

    for (const testCase of testCases) {
      console.info(`test name: ${testCase.testName}`);

      const sender = new Sender(
        await SenderOptions.resolveAuto({
          protocol: "tcp",
          host: "host",
          auto_flush: false,
          init_buf_size: 1024,
          protocol_version: PROTOCOL_VERSION_V3,
        }),
      );

      let errorMessage: string | undefined = undefined;
      try {
        sender.table(testCase.table);
        for (const symbol of testCase.symbols) {
          sender.symbol(symbol.name, symbol.value);
        }
        for (const column of testCase.columns) {
          switch (column.type) {
            case "STRING":
              sender.stringColumn(column.name, column.value);
              break;
            case "LONG":
              sender.intColumn(column.name, column.value);
              break;
            case "DOUBLE":
              sender.floatColumn(column.name, column.value);
              break;
            case "BOOLEAN":
              sender.booleanColumn(column.name, column.value);
              break;
            case "TIMESTAMP":
              sender.timestampColumn(column.name, column.value);
              break;
            case "DECIMAL":
              const [unscaled, scale] = parseDecimal(column.value);
              sender.decimalColumnUnscaled(column.name, unscaled, scale);
              break;
            default:
              errorMessage = "Unsupported column type";
          }
          if (errorMessage) {
            break;
          }
        }
        await sender.atNow();
      } catch (e) {
        if (testCase.result.status === "ERROR") {
          // error is expected, continue to next test case
          continue;
        }
        errorMessage = `Unexpected error: ${(e as Error).message}`;
      }

      if (!errorMessage) {
        const actualLine = bufferContent(sender);

        if (testCase.result.status === "SUCCESS") {
          if (testCase.result.binaryBase64) {
            const expectedBuffer = Buffer.from(
              testCase.result.binaryBase64,
              "base64",
            );
            expect(buffer(sender)).toEqual(expectedBuffer);
          } else if (testCase.result.anyLines) {
            let foundMatch = false;
            for (const expectedLine of testCase.result.anyLines) {
              if (actualLine === expectedLine + "\n") {
                foundMatch = true;
                break;
              }
            }
            if (!foundMatch) {
              errorMessage = `Line is not matching any of the expected results: ${actualLine}`;
            }
          } else if (testCase.result.line) {
            expect(actualLine).toBe(testCase.result.line + "\n");
          } else {
            errorMessage = "No expected result line provided";
          }
        } else {
          errorMessage = `Expected error missing, buffer's content: ${actualLine}`;
        }
      }

      await sender.close();
      expect(errorMessage).toBeUndefined();
    }
  });
});

describe("Sender message builder test suite (anything not covered in client interop test suite)", function () {
  it("supports json object", async function () {
    const pages: Array<{
      id: string;
      gridId: string;
    }>[] = [];
    for (let i = 0; i < 4; i++) {
      const pageProducts: Array<{
        id: string;
        gridId: string;
      }> = [
        {
          id: "46022e96-076f-457f-b630-51b82b871618" + i,
          gridId: "46022e96-076f-457f-b630-51b82b871618",
        },
        {
          id: "55615358-4af1-4179-9153-faaa57d71e55",
          gridId: "55615358-4af1-4179-9153-faaa57d71e55",
        },
        {
          id: "365b9cdf-3d4e-4135-9cb0-f1a65601c840",
          gridId: "365b9cdf-3d4e-4135-9cb0-f1a65601c840",
        },
        {
          id: "0b67ddf2-8e69-4482-bf0c-bb987ee5c280",
          gridId: "0b67ddf2-8e69-4482-bf0c-bb987ee5c280" + i,
        },
      ];
      pages.push(pageProducts);
    }

    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 256,
    });
    for (const p of pages) {
      await sender
        .table("tableName")
        .stringColumn("page_products", JSON.stringify(p || []))
        .booleanColumn("boolCol", true)
        .atNow();
    }
    expect(bufferContent(sender)).toBe(
      'tableName page_products="[{\\"id\\":\\"46022e96-076f-457f-b630-51b82b8716180\\",\\"gridId\\":\\"46022e96-076f-457f-b630-51b82b871618\\"},{\\"id\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\",\\"gridId\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\"},{\\"id\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\",\\"gridId\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\"},{\\"id\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c280\\",\\"gridId\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c2800\\"}]",boolCol=t\n' +
        'tableName page_products="[{\\"id\\":\\"46022e96-076f-457f-b630-51b82b8716181\\",\\"gridId\\":\\"46022e96-076f-457f-b630-51b82b871618\\"},{\\"id\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\",\\"gridId\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\"},{\\"id\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\",\\"gridId\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\"},{\\"id\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c280\\",\\"gridId\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c2801\\"}]",boolCol=t\n' +
        'tableName page_products="[{\\"id\\":\\"46022e96-076f-457f-b630-51b82b8716182\\",\\"gridId\\":\\"46022e96-076f-457f-b630-51b82b871618\\"},{\\"id\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\",\\"gridId\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\"},{\\"id\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\",\\"gridId\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\"},{\\"id\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c280\\",\\"gridId\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c2802\\"}]",boolCol=t\n' +
        'tableName page_products="[{\\"id\\":\\"46022e96-076f-457f-b630-51b82b8716183\\",\\"gridId\\":\\"46022e96-076f-457f-b630-51b82b871618\\"},{\\"id\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\",\\"gridId\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\"},{\\"id\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\",\\"gridId\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\"},{\\"id\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c280\\",\\"gridId\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c2803\\"}]",boolCol=t\n',
    );
    await sender.close();
  });

  it("does not support arrays with protocol v1", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table("tableName").arrayColumn("arrayCol", [12.3, 23.4]),
    ).toThrow("Arrays are not supported in protocol v1");
    await sender.close();
  });

  it("supports arrays with protocol v2", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .arrayColumn("arrayCol", [12.3, 23.4])
      .atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("tableName arrayCol==") +
        " 0e 0a 01 02 00 00 00 9a 99 99 99 99 99 28 40 66 66 66 66 66 66 37 40 " +
        toHex("\n"),
    );
    await sender.close();
  });

  it("supports arrays with zeros", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    await sender.table("tableName").arrayColumn("arrayCol", [0.0, 0.0]).atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("tableName arrayCol==") +
        " 0e 0a 01 02 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 " +
        toHex("\n"),
    );
    await sender.close();
  });

  it("supports multidimensional arrays with protocol v2", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .arrayColumn("arrayCol", [[12.3], [23.4]])
      .atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("tableName arrayCol==") +
        " 0e 0a 02 02 00 00 00 01 00 00 00 9a 99 99 99 99 99 28 40 66 66 66 66 66 66 37 40 " +
        toHex("\n"),
    );
    await sender.close();
  });

  it("accepts empty array", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    await sender.table("tableName").arrayColumn("arrayCol", []).atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("tableName arrayCol==") + " 0e 0a 01 00 00 00 00 " + toHex("\n"),
    );
    await sender.close();
  });

  it("accepts multi dimensional empty array", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .arrayColumn("arrayCol", [
        [[], []],
        [[], []],
        [[], []],
      ])
      .atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("tableName arrayCol==") +
        " 0e 0a 03 03 00 00 00 02 00 00 00 00 00 00 00 " +
        toHex("\n"),
    );
    await sender.close();
  });

  it("does not accept irregularly sized array", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table("tableName").arrayColumn("arrayCol", [
        [
          [1.1, 2.2],
          [3.3, 4.4],
          [5.5, 6.6],
        ],
        [
          [1.1, 2.2],
          [3.3, 4.4],
          [5.5, 6.6],
        ],
        [
          [1.1, 2.2],
          [3.3, 4.4],
          [5.5, 6.6],
        ],
        [[1.1, 2.2], [3.3], [5.5, 6.6]],
      ]),
    ).toThrow(
      "Lengths of sub-arrays do not match [expected=2, actual=1, dimensions=[4,3,2], path=[3][1]]",
    );
    await sender.close();
  });

  it("does not accept non-homogenous array", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    sender.table("tableName");
    expect(() =>
      sender.arrayColumn("arrayCol", [
        [
          [1.1, 2.2],
          [3.3, 4.4],
          [5.5, 6.6],
        ],
        [
          [1.1, 2.2],
          [3.3, 4.4],
          [5.5, 6.6],
        ],
        [
          [1.1, 2.2],
          [3.3, 4.4],
          [5.5, 6.6],
        ],
        [
          [1.1, 2.2],
          [3.3, "4.4"],
          [5.5, 6.6],
        ],
      ]),
    ).toThrow(
      "Mixed types found [expected=number, current=string, path=[3][1][1]]",
    );
    expect(() =>
      sender.arrayColumn("arrayCol", [
        [
          [1.1, 2.2],
          [3.3, 4.4],
          [5.5, 6.6],
        ],
        [
          [1.1, 2.2],
          [3.3, 4.4],
          [5.5, 6.6],
        ],
        [
          [1.1, 2.2],
          [3.3, 4.4],
          [5.5, 6.6],
        ],
        [[1.1, 2.2], 3.3, [5.5, 6.6]],
      ]),
    ).toThrow(
      "Mixed types found [expected=array, current=number, path=[3][1]]",
    );
    await sender.close();
  });

  it("does not accept unsupported types", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    sender.table("tableName");
    expect(() => sender.arrayColumn("col", ["str"])).toThrow(
      "Unsupported array type [type=string]",
    );
    expect(() => sender.arrayColumn("col", [true])).toThrow(
      "Unsupported array type [type=boolean]",
    );
    expect(() => sender.arrayColumn("col", [{}])).toThrow(
      "Unsupported array type [type=object]",
    );
    expect(() => sender.arrayColumn("col", [null])).toThrow(
      "Unsupported array type [type=object]",
    );
    expect(() => sender.arrayColumn("col", [undefined])).toThrow(
      "Unsupported array type [type=undefined]",
    );
    await sender.close();
  });

  it("does not accept non-array types", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    sender.table("tableName");
    // @ts-expect-error - Testing invalid input
    expect(() => sender.arrayColumn("col", 12.345)).toThrow(
      "The value must be an array [value=12.345, type=number]",
    );
    // @ts-expect-error - Testing invalid input
    expect(() => sender.arrayColumn("col", 42)).toThrow(
      "The value must be an array [value=42, type=number]",
    );
    // @ts-expect-error - Testing invalid input
    expect(() => sender.arrayColumn("col", "str")).toThrow(
      'The value must be an array [value="str", type=string]',
    );
    // @ts-expect-error - Testing invalid input
    expect(() => sender.arrayColumn("col", "")).toThrow(
      'The value must be an array [value="", type=string]',
    );
    // @ts-expect-error - Testing invalid input
    expect(() => sender.arrayColumn("col", true)).toThrow(
      "The value must be an array [value=true, type=boolean]",
    );
    // @ts-expect-error - Testing invalid input
    expect(() => sender.arrayColumn("col", {})).toThrow(
      "The value must be an array [value={}, type=object]",
    );
    await sender.close();
  });

  it("supports arrays with NULL value", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .arrayColumn("arrayCol", undefined as unknown as unknown[])
      .atNow();
    await sender
      .table("tableName")
      .arrayColumn("arrayCol", null as unknown as unknown[])
      .atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("tableName arrayCol==") +
        " 0e 21 " +
        toHex("\ntableName arrayCol==") +
        " 0e 21 " +
        toHex("\n"),
    );
    await sender.close();
  });

  it("throws on invalid timestamp unit", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      auto_flush: false,
      init_buf_size: 1024,
    });

    await expect(
      async () =>
        await sender
          .table("tableName")
          .booleanColumn("boolCol", true)
          // @ts-expect-error - Testing invalid timestamp unit
          .timestampColumn("timestampCol", 1658484765000000, "foobar")
          .atNow(),
    ).rejects.toThrow("Unknown timestamp unit: foobar");
    await sender.close();
  });

  it("supports timestamp field as number for 'us' and 'ms' units with protocol v1", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await expect(
      async () =>
        await sender
          .table("tableName")
          .timestampColumn("ts", 1658484765000000, "ns")
          .atNow(),
    ).rejects.toThrow(
      "Timestamp value must be a BigInt if it is set in nanoseconds",
    );

    sender.reset();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123456)
      .atNow();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123456, "us")
      .atNow();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123, "ms")
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName ts=1658484765123456t\n" +
        "tableName ts=1658484765123456t\n" +
        "tableName ts=1658484765123000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as number for 'us' and 'ms' units with protocol v2", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    await expect(
      async () =>
        await sender
          .table("tableName")
          .timestampColumn("ts", 1658484765000000, "ns")
          .atNow(),
    ).rejects.toThrow(
      "Timestamp value must be a BigInt if it is set in nanoseconds",
    );

    sender.reset();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123456)
      .atNow();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123456, "us")
      .atNow();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123, "ms")
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName ts=1658484765123456t\n" +
        "tableName ts=1658484765123456t\n" +
        "tableName ts=1658484765123000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as BigInt with protocol v1", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123456n)
      .atNow();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123456789n, "ns")
      .atNow();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123456n, "us")
      .atNow();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123n, "ms")
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName ts=1658484765123456t\n" +
        "tableName ts=1658484765123456t\n" +
        "tableName ts=1658484765123456t\n" +
        "tableName ts=1658484765123000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as BigInt with protocol v2", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123456n)
      .atNow();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123456789n, "ns")
      .atNow();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123456n, "us")
      .atNow();
    await sender
      .table("tableName")
      .timestampColumn("ts", 1658484765123n, "ms")
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName ts=1658484765123456t\n" +
        "tableName ts=1658484765123456789n\n" +
        "tableName ts=1658484765123456t\n" +
        "tableName ts=1658484765123000t\n",
    );
    await sender.close();
  });

  it("throws on invalid designated timestamp unit", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });

    await expect(
      async () =>
        await sender
          .table("tableName")
          .booleanColumn("boolCol", true)
          .timestampColumn("timestampCol", 1658484765000000)
          // @ts-expect-error - Testing invalid timestamp unit
          .at(1658484769000000, "foobar"),
    ).rejects.toThrow("Unknown timestamp unit: foobar");
    await sender.close();
  });

  it("supports designated timestamp as number for 'us' and 'ms' units with protocol v1", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await expect(
      async () =>
        await sender
          .table("tableName")
          .intColumn("c1", 42)
          .at(1658484769000000, "ns"),
    ).rejects.toThrow(
      "Designated timestamp must be a BigInt if it is set in nanoseconds",
    );

    sender.reset();
    await sender.table("tableName").intColumn("c1", 42).at(1658484769000000);
    await sender
      .table("tableName")
      .intColumn("c1", 42)
      .at(1658484769000000, "us");
    await sender.table("tableName").intColumn("c1", 42).at(1658484769000, "ms");
    expect(bufferContent(sender)).toBe(
      "tableName c1=42i 1658484769000000000\n" +
        "tableName c1=42i 1658484769000000000\n" +
        "tableName c1=42i 1658484769000000000\n",
    );
    await sender.close();
  });

  it("supports designated timestamp as number for 'us' and 'ms' units with protocol v2", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    await expect(
      async () =>
        await sender
          .table("tableName")
          .intColumn("c1", 42)
          .at(1658484769000000, "ns"),
    ).rejects.toThrow(
      "Designated timestamp must be a BigInt if it is set in nanoseconds",
    );

    sender.reset();
    await sender.table("tableName").intColumn("c1", 42).at(1658484769000000);
    await sender
      .table("tableName")
      .intColumn("c1", 42)
      .at(1658484769000000, "us");
    await sender.table("tableName").intColumn("c1", 42).at(1658484769000, "ms");
    expect(bufferContent(sender)).toBe(
      "tableName c1=42i 1658484769000000t\n" +
        "tableName c1=42i 1658484769000000t\n" +
        "tableName c1=42i 1658484769000000t\n",
    );
    await sender.close();
  });

  it("supports designated timestamp as BigInt with protocol v1", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await sender.table("tableName").intColumn("c1", 42).at(1658484769000000n);
    await sender
      .table("tableName")
      .intColumn("c1", 42)
      .at(1658484769000000n, "ns");
    await sender
      .table("tableName")
      .intColumn("c1", 42)
      .at(1658484769000000n, "us");
    await sender
      .table("tableName")
      .intColumn("c1", 42)
      .at(1658484769000n, "ms");
    expect(bufferContent(sender)).toBe(
      "tableName c1=42i 1658484769000000000\n" +
        "tableName c1=42i 1658484769000000\n" +
        "tableName c1=42i 1658484769000000000\n" +
        "tableName c1=42i 1658484769000000000\n",
    );
    await sender.close();
  });

  it("supports designated timestamp as BigInt with protocol v2", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 1024,
    });
    await sender.table("tableName").intColumn("c1", 42).at(1658484769000000n);
    await sender
      .table("tableName")
      .intColumn("c1", 42)
      .at(1658484769000000n, "ns");
    await sender
      .table("tableName")
      .intColumn("c1", 42)
      .at(1658484769000000n, "us");
    await sender
      .table("tableName")
      .intColumn("c1", 42)
      .at(1658484769000n, "ms");
    expect(bufferContent(sender)).toBe(
      "tableName c1=42i 1658484769000000t\n" +
        "tableName c1=42i 1658484769000000n\n" +
        "tableName c1=42i 1658484769000000t\n" +
        "tableName c1=42i 1658484769000000t\n",
    );
    await sender.close();
  });

  it("throws exception if table name is not a string", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    // @ts-expect-error - Invalid options
    expect(() => sender.table(23456)).toThrow(
      "Table name must be a string, received number",
    );
    await sender.close();
  });

  it("throws exception if table name is too long", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table(
        "123456789012345678901234567890123456789012345678901234567890" +
          "12345678901234567890123456789012345678901234567890123456789012345678",
      ),
    ).toThrow("Table name is too long, max length is 127");
    await sender.close();
  });

  it("throws exception if table name is set more times", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table("tableName").symbol("name", "value").table("newTableName"),
    ).toThrow("Table name has already been set");
    await sender.close();
  });

  it("throws exception if symbol name is not a string", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    // @ts-expect-error - Invalid options
    expect(() => sender.table("tableName").symbol(12345.5656, "value")).toThrow(
      "Symbol name must be a string, received number",
    );
    await sender.close();
  });

  it("throws exception if symbol name is empty string", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() => sender.table("tableName").symbol("", "value")).toThrow(
      "Empty string is not allowed as column name",
    );
    await sender.close();
  });

  it("throws exception if column name is not a string", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      // @ts-expect-error - Invalid options
      sender.table("tableName").stringColumn(12345.5656, "value"),
    ).toThrow("Column name must be a string, received number");
    await sender.close();
  });

  it("throws exception if column name is empty string", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() => sender.table("tableName").stringColumn("", "value")).toThrow(
      "Empty string is not allowed as column name",
    );
    await sender.close();
  });

  it("throws exception if column name is too long", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender
        .table("tableName")
        .stringColumn(
          "123456789012345678901234567890123456789012345678901234567890" +
            "12345678901234567890123456789012345678901234567890123456789012345678",
          "value",
        ),
    ).toThrow("Column name is too long, max length is 127");
    await sender.close();
  });

  it("throws exception if column value is not the right type", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      // @ts-expect-error - Invalid options
      sender.table("tableName").stringColumn("columnName", false),
    ).toThrow("Column value must be of type string, received boolean");
    await sender.close();
  });

  it("throws exception if adding column without setting table name", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() => sender.floatColumn("name", 12.459)).toThrow(
      "Column can be set only after table name is set",
    );
    await sender.close();
  });

  it("throws exception if adding symbol without setting table name", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() => sender.symbol("name", "value")).toThrow(
      "Symbol can be added only after table name is set and before any column added",
    );
    await sender.close();
  });

  it("throws exception if adding symbol after columns", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender
        .table("tableName")
        .stringColumn("name", "value")
        .symbol("symbolName", "symbolValue"),
    ).toThrow(
      "Symbol can be added only after table name is set and before any column added",
    );
    await sender.close();
  });

  it("returns null if preparing an empty buffer for send", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    // @ts-expect-error - Accessing private field
    expect(sender.buffer.toBufferView()).toBe(null);
    // @ts-expect-error - Accessing private field
    expect(sender.buffer.toBufferNew()).toBe(null);
    await sender.close();
  });

  it("leaves unfinished rows in the sender's buffer when preparing a copy of the buffer for send", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    sender.table("tableName").symbol("name", "value");
    await sender.at(1234567890n, "ns");
    sender.table("tableName").symbol("name", "value2");

    // copy of the sender's buffer contains the finished row
    // @ts-expect-error - Accessing private field
    expect(sender.buffer.toBufferNew().toString()).toBe(
      "tableName,name=value 1234567890\n",
    );
    // the sender's buffer is compacted, and contains only the unfinished row
    // @ts-expect-error - Accessing private field
    expect(sender.buffer.toBufferView(bufferPosition(sender)).toString()).toBe(
      "tableName,name=value2",
    );
    await sender.close();
  });

  it("throws exception if a float is passed as integer field", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table("tableName").intColumn("intField", 123.222),
    ).toThrow("Value must be an integer, received 123.222");
    await sender.close();
  });

  it("throws exception if a float is passed as timestamp field", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table("tableName").timestampColumn("intField", 123.222),
    ).toThrow("Timestamp value must be an integer or BigInt, received 123.222");
    await sender.close();
  });

  it("throws exception if designated timestamp is not an integer or bigint", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      await sender
        .table("tableName")
        .symbol("name", "value")
        .at(23232322323.05);
    } catch (e: Error | any) {
      expect(e.message).toEqual(
        "Designated timestamp must be an integer or BigInt, received 23232322323.05",
      );
    }
    await sender.close();
  });

  it("throws exception if designated timestamp is invalid", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      // @ts-expect-error - Invalid options
      await sender.table("tableName").symbol("name", "value").at("invalid_dts");
    } catch (e: Error | any) {
      expect(e.message).toEqual(
        "Designated timestamp must be an integer or BigInt, received invalid_dts",
      );
    }
    await sender.close();
  });

  it("throws exception if designated timestamp is set without any fields added", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      await sender.table("tableName").at(12345678n, "ns");
    } catch (e: Error | any) {
      expect(e.message).toEqual(
        "The row must have a symbol or column set before it is closed",
      );
    }
    await sender.close();
  });

  it("extends the size of the buffer v1 if data does not fit", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 8,
    });
    expect(bufferSize(sender)).toBe(8);
    expect(bufferPosition(sender)).toBe(0);
    sender.table("tableName");
    expect(bufferSize(sender)).toBe(24);
    expect(bufferPosition(sender)).toBe("tableName".length);
    sender.intColumn("intField", 123);
    expect(bufferSize(sender)).toBe(48);
    expect(bufferPosition(sender)).toBe("tableName intField=123i".length);
    await sender.atNow();
    expect(bufferSize(sender)).toBe(48);
    expect(bufferPosition(sender)).toBe("tableName intField=123i\n".length);
    expect(bufferContent(sender)).toBe("tableName intField=123i\n");

    await sender
      .table("table2")
      .intColumn("intField", 125)
      .stringColumn("strField", "test")
      .atNow();
    expect(bufferSize(sender)).toBe(96);
    expect(bufferPosition(sender)).toBe(
      'tableName intField=123i\ntable2 intField=125i,strField="test"\n'.length,
    );
    expect(bufferContent(sender)).toBe(
      'tableName intField=123i\ntable2 intField=125i,strField="test"\n',
    );
    await sender.close();
  });

  it("extends the size of the buffer v2 if data does not fit", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "host",
      init_buf_size: 8,
    });
    expect(bufferSize(sender)).toBe(8);
    expect(bufferPosition(sender)).toBe(0);
    sender.table("tableName");
    expect(bufferSize(sender)).toBe(24);
    expect(bufferPosition(sender)).toBe("tableName".length);
    sender.floatColumn("floatField", 123.456);
    expect(bufferSize(sender)).toBe(48);
    expect(bufferPosition(sender)).toBe("tableName floatField=".length + 10);
    sender.stringColumn("strField", "hoho");
    expect(bufferSize(sender)).toBe(96);
    expect(bufferPosition(sender)).toBe(
      "tableName floatField=".length + 10 + ',strField="hoho"'.length,
    );
    await sender.atNow();
    expect(bufferSize(sender)).toBe(96);
    expect(bufferPosition(sender)).toBe(
      "tableName floatField=".length + 10 + ',strField="hoho"\n'.length,
    );
    expect(bufferContentHex(sender)).toBe(
      toHex("tableName floatField=") +
        " 3d 10 77 be 9f 1a 2f dd 5e 40 " +
        toHex(',strField="hoho"\n'),
    );
    await sender.close();
  });

  it("throws exception if tries to extend the size of the buffer above max buffer size", async function () {
    const sender = await Sender.fromConfig(
      "tcp::addr=host;init_buf_size=8;max_buf_size=64;",
    );
    expect(bufferSize(sender)).toBe(8);
    expect(bufferPosition(sender)).toBe(0);
    sender.table("tableName");
    expect(bufferSize(sender)).toBe(24);
    expect(bufferPosition(sender)).toBe("tableName".length);
    sender.intColumn("intField", 123);
    expect(bufferSize(sender)).toBe(48);
    expect(bufferPosition(sender)).toBe("tableName intField=123i".length);
    await sender.atNow();
    expect(bufferSize(sender)).toBe(48);
    expect(bufferPosition(sender)).toBe("tableName intField=123i\n".length);
    expect(bufferContent(sender)).toBe("tableName intField=123i\n");

    try {
      await sender
        .table("table2")
        .intColumn("intField", 125)
        .stringColumn("strField", "test")
        .atNow();
    } catch (err: Error | any) {
      expect(err.message).toBe(
        "Max buffer size is 64 bytes, requested buffer size: 96",
      );
    }
    await sender.close();
  });

  it("is possible to clear the buffer by calling reset()", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000)
      .atNow();
    await sender
      .table("tableName")
      .booleanColumn("boolCol", false)
      .timestampColumn("timestampCol", 1658484766000000)
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n" +
        "tableName boolCol=f,timestampCol=1658484766000000t\n",
    );

    sender.reset();
    await sender
      .table("tableName")
      .floatColumn("floatCol", 1234567890)
      .timestampColumn("timestampCol", 1658484767000000)
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName floatCol=1234567890,timestampCol=1658484767000000t\n",
    );
    await sender.close();
  });

  it("writes decimal columns in text format with protocol v3", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    await sender.table("fx").decimalColumnText("mid", "1.234500").atNow();
    expect(bufferContent(sender)).toBe("fx mid=1.234500d\n");
    await sender.close();
  });

  it("writes decimal columns in binary format with bigint input small", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    await sender.table("fx").decimalColumnUnscaled("mid", 12345n, 2).atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("fx mid==") + " 17 02 02 30 39 " + toHex("\n"),
    );
    await sender.close();
  });

  it("writes decimal columns in binary format with bigint input", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    await sender.table("fx").decimalColumnUnscaled("mid", 1234500n, 6).atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("fx mid==") + " 17 06 03 12 d6 44 " + toHex("\n"),
    );
    await sender.close();
  });

  it("writes decimal columns in binary format with Int8Array input", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("fx")
      .decimalColumnUnscaled("mid", new Int8Array([0xff, 0xf6]), 2)
      .atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("fx mid==") + " 17 02 02 ff f6 " + toHex("\n"),
    );
    await sender.close();
  });

  it("accepts numeric inputs for decimalColumnText", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    await sender.table("fx").decimalColumnText("mid", -42.5).atNow();
    expect(bufferContent(sender)).toBe("fx mid=-42.5d\n");
    await sender.close();
  });

  it("throws on invalid decimal text literal", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() => sender.table("fx").decimalColumnText("mid", "1.2.3")).toThrow(
      "Invalid decimal text: 1.2.3",
    );
    sender.reset();
    await sender.close();
  });

  it("throws on unsupported decimal text value type", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table("fx").decimalColumnText("mid", true as unknown as number),
    ).toThrow("Invalid decimal value type: boolean");
    sender.reset();
    await sender.close();
  });

  it("encodes positive bigint decimals that require sign extension", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    await sender.table("fx").decimalColumnUnscaled("mid", 255n, 1).atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("fx mid==") + " 17 01 02 00 ff " + toHex("\n"),
    );
    await sender.close();
  });

  it("encodes negative bigint decimals with the proper two's complement payload", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    await sender.table("fx").decimalColumnUnscaled("mid", -10n, 2).atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("fx mid==") + " 17 02 02 ff f6 " + toHex("\n"),
    );
    await sender.close();
  });

  it("encodes null decimals when unscaled payload is empty", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("fx")
      .decimalColumnUnscaled("mid", new Int8Array(0), 0)
      .atNow();
    expect(bufferContentHex(sender)).toBe(
      toHex("fx mid==") + " 17 00 00 " + toHex("\n"),
    );
    await sender.close();
  });

  it("throws when decimal scale is outside the accepted range", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table("fx").decimalColumnUnscaled("mid", 1n, -1),
    ).toThrow("Scale must be between 0 and 76");
    sender.reset();
    expect(() =>
      sender.table("fx").decimalColumnUnscaled("mid", 1n, 77),
    ).toThrow("Scale must be between 0 and 76");
    sender.reset();
    await sender.close();
  });

  it("throws when unscaled payload is not Int8Array or bigint", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender
        .table("fx")
        .decimalColumnUnscaled("mid", "oops" as unknown as Int8Array, 1),
    ).toThrow(
      "Invalid unscaled value type: string, expected Int8Array or bigint",
    );
    sender.reset();
    await sender.close();
  });

  it("throws when unscaled payload exceeds maximum length", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table("fx").decimalColumnUnscaled("mid", new Int8Array(128), 0),
    ).toThrow("Unscaled value length must be between 0 and 127 bytes");
    sender.reset();
    await sender.close();
  });

  it("doesn't send the decimal text column when undefined is passed as value", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      await sender.table("fx").decimalColumnText("mid", undefined).atNow();
    } catch (e: Error | any) {
      expect(e.message).toEqual(
        "The row must have a symbol or column set before it is closed",
      );
    }
    sender.reset();
    await sender.close();
  });

  it("doesn't send the decimal text column when null is passed as value", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      await sender.table("fx").decimalColumnText("mid", null).atNow();
    } catch (e: Error | any) {
      expect(e.message).toEqual(
        "The row must have a symbol or column set before it is closed",
      );
    }
    sender.reset();
    await sender.close();
  });

  it("doesn't send the decimal unscaled column when undefined is passed as value", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      await sender
        .table("fx")
        .decimalColumnUnscaled("mid", undefined, 0)
        .atNow();
    } catch (e: Error | any) {
      expect(e.message).toEqual(
        "The row must have a symbol or column set before it is closed",
      );
    }
    sender.reset();
    await sender.close();
  });

  it("doesn't send the decimal unscaled column when null is passed as value", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "3",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      await sender.table("fx").decimalColumnUnscaled("mid", null, 0).atNow();
    } catch (e: Error | any) {
      expect(e.message).toEqual(
        "The row must have a symbol or column set before it is closed",
      );
    }
    sender.reset();
    await sender.close();
  });
});

function bufferContent(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return sender.buffer.toBufferView().toString();
}

function bufferContentHex(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return toHexString(sender.buffer.toBufferView());
}

function toHex(str: string) {
  return toHexString(Buffer.from(str));
}

function toHexString(buffer: Buffer) {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

function buffer(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return sender.buffer.toBufferView();
}

function bufferSize(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return sender.buffer.bufferSize;
}

function bufferPosition(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return sender.buffer.position;
}

// parseDecimal quick and dirty parser for a decimal value from its string representation
function parseDecimal(s: string): [bigint, number] {
  // Remove whitespace
  s = s.trim();

  // Check for empty string
  if (s === "") {
    throw new Error("invalid decimal64: empty string");
  }

  // Find the decimal point and remove it
  const pointIndex = s.indexOf(".");
  if (pointIndex !== -1) {
    s = s.replace(/\./g, "");
  }

  // Parse the integer part
  const unscaled = BigInt(s);
  let scale = 0;
  if (pointIndex !== -1) {
    scale = s.length - pointIndex;
  }

  return [unscaled, scale];
}
