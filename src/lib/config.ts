export interface Config {
  host: string;
  port: number;
  nodeEnv: string;
  databaseFilePath: string;
}

export function loadConfig(): Config {
  return {
    // Loopback by default: deployed behind nginx, only the proxy should be
    // able to reach the app directly. Set HOST=0.0.0.0 to expose it.
    host: process.env.HOST ?? "127.0.0.1",
    port: parseInt(process.env.PORT ?? "3000", 10),
    nodeEnv: process.env.NODE_ENV ?? "development",
    databaseFilePath: process.env.DATABASE_FILE_PATH ?? "database.sqlite",
  };
}
