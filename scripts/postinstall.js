const {exec} = require('child_process');

switch (process.platform) {
    case 'linux':
        console.log("Linux");
        break;
    case 'win32':
        console.log("Windows");
        break;
    case 'darwin':
        console.log("MacOS");
        break;
    case 'freebsd':
        console.log("FreeBSD");
        break;
    case 'openbsd':
        console.log("OpenBSD");
        break;
    case 'aix':
        console.log("AIX");
        break;
    case 'sunos':
        console.log("SunOS");
        break;
    default:
        console.log("Other OS");
}

switch (process.arch) {
    case 'x64':
        console.log("x64");
        break;
    case 'arm64':
        console.log("arm64");
        break;
    case 'arm':
        console.log("arm");
        break;
    case 'ia32':
        console.log("ia32");
        break;
    case 'mips':
        console.log("mips");
        break;
    case 'mipsel':
        console.log("mipsel");
        break;
    case 'ppc':
        console.log("ppc");
        break;
    case 'ppc64':
        console.log("ppc64");
        break;
    case 's390':
        console.log("s390");
        break;
    case 's390x':
        console.log("s390x");
        break;
    default:
        console.log("Other CPU architecture");
}

if (process.platform === "darwin" && process.arch === "arm64") {
    const commands = [
        'cp lib/mac/arm64/questdbclient.node .'
    ];

    const executedCommands = exec(commands.join('&&'), error => {
        if (error) {
            throw error;
        }
    });

    executedCommands.on("exit", (code, signal) => {
        console.log("code=" + code + ", signal=" + signal);
    });
}
