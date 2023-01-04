'use strict';

describe('Default logging suite', function () {
    let error, warn, info, debug;
    let log;

    beforeAll(() => {
        error = jest.spyOn(console, "error").mockImplementation(() => {});
        warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        info = jest.spyOn(console, "info").mockImplementation(() => {});
        debug = jest.spyOn(console, "debug").mockImplementation(() => {});
        log = require("../src/logging").log;
    });

    afterAll(() => {
        error.mockReset();
        warn.mockReset();
        info.mockReset();
        debug.mockReset();
    });

    afterEach(() => {
        error.mockClear();
        warn.mockClear();
        info.mockClear();
        debug.mockClear();
    });

    it('can log error level messages', function () {
        const testMessage = "ERROR ERROR ERROR";
        log("error", testMessage);
        expect(error).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(0);
        expect(info).toHaveBeenCalledTimes(0);
        expect(debug).toHaveBeenCalledTimes(0);
        expect(error).toHaveBeenCalledWith(testMessage);
    });

    it('can log warn level messages', function () {
        const testMessage = "WARN WARN WARN";
        log("warn", testMessage);
        expect(error).toHaveBeenCalledTimes(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(info).toHaveBeenCalledTimes(0);
        expect(debug).toHaveBeenCalledTimes(0);
        expect(warn).toHaveBeenCalledWith(testMessage);
    });

    it('can log info level messages', function () {
        const testMessage = "INFO INFO INFO";
        log("info", testMessage);
        expect(error).toHaveBeenCalledTimes(0);
        expect(warn).toHaveBeenCalledTimes(0);
        expect(info).toHaveBeenCalledTimes(1);
        expect(debug).toHaveBeenCalledTimes(0);
        expect(info).toHaveBeenCalledWith(testMessage);
    });

    it('cannot log debug level messages', function () {
        const testMessage = "DEBUG DEBUG DEBUG";
        log("debug", testMessage);
        expect(error).toHaveBeenCalledTimes(0);
        expect(warn).toHaveBeenCalledTimes(0);
        expect(info).toHaveBeenCalledTimes(0);
        expect(debug).toHaveBeenCalledTimes(0);
    });

    it('throws exception if log level is not supported', function () {
        expect(
            () => log("trace", "TRACE TRACE TRACE")
        ).toThrow("Invalid log level: 'trace'");
    });
});
