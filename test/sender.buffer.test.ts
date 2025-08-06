// @ts-check
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

import { Sender } from "../src";
import { SenderOptions } from "../src/options";

describe("Client interop test suite", function () {
  it("runs client tests as per json test config", async function () {
    const testCases = JSON.parse(
      readFileSync(
        "./questdb-client-test/ilp-client-interop-test.json",
      ).toString(),
    );

    for (const testCase of testCases) {
      console.info(`test name: ${testCase.testName}`);

      const sender = new Sender(
        await SenderOptions.resolveAuto({
          protocol: "tcp",
          host: "host",
          auto_flush: false,
          init_buf_size: 1024,
        }),
      );

      let errorMessage: string;
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
        errorMessage = `Unexpected error: ${e.message}`;
      }

      if (!errorMessage) {
        const actualLine = bufferContent(sender);

        if (testCase.result.status === "SUCCESS") {
          if (testCase.result.line) {
            expect(actualLine).toBe(testCase.result.line + "\n");
          } else {
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
          // @ts-expect-error - Testing invalid options
          .timestampColumn("timestampCol", 1658484765000000, "foobar")
          .atNow(),
    ).rejects.toThrow("Unknown timestamp unit: foobar");
    await sender.close();
  });

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

  it("supports timestamp field as number", async function () {
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
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as ns number", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000, "ns")
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as us number", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000, "us")
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as ms number", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000, "ms")
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as BigInt", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000n)
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as ns BigInt", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000000n, "ns")
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as us BigInt", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000n, "us")
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as ms BigInt", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000n, "ms")
      .atNow();
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
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
    try {
      await sender
        .table("tableName")
        .booleanColumn("boolCol", true)
        .timestampColumn("timestampCol", 1658484765000000)
        // @ts-expect-error - Testing invalid options
        .at(1658484769000000, "foobar");
    } catch (err) {
      expect(err.message).toBe("Unknown timestamp unit: foobar");
    }
    await sender.close();
  });

  it("supports setting designated us timestamp as number from client", async function () {
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
      .at(1658484769000000, "us");
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n",
    );
    await sender.close();
  });

  it("supports setting designated ms timestamp as number from client", async function () {
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
      .at(1658484769000, "ms");
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n",
    );
    await sender.close();
  });

  it("supports setting designated timestamp as BigInt from client", async function () {
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
      .at(1658484769000000n);
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n",
    );
    await sender.close();
  });

  it("supports setting designated ns timestamp as BigInt from client", async function () {
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
      .at(1658484769000000123n, "ns");
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000123\n",
    );
    await sender.close();
  });

  it("supports setting designated us timestamp as BigInt from client", async function () {
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
      .at(1658484769000000n, "us");
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n",
    );
    await sender.close();
  });

  it("supports setting designated ms timestamp as BigInt from client", async function () {
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
      .at(1658484769000n, "ms");
    expect(bufferContent(sender)).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n",
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
    ).toThrow("Value must be an integer or BigInt, received 123.222");
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
    } catch (e) {
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
    } catch (e) {
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
    } catch (e) {
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
    } catch (err) {
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

function bufferSize(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return sender.buffer.bufferSize;
}

function bufferPosition(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return sender.buffer.position;
}
