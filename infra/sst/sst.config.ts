export default $config({
  app(input?: { stage?: string }) {
    return {
      name: "anvil-registry",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws"
    };
  },

  async run() {
    const vpc = new sst.aws.Vpc("Vpc");
    const cluster = new sst.aws.Cluster("Cluster", { vpc });
    const bucket = new sst.aws.Bucket("PackageCache");
    const queue = new sst.aws.Queue("AnalysisQueue");
    const database = new sst.aws.Postgres("Database", {
      vpc,
      database: "anvil",
      username: "anvil",
      dev: {
        host: "localhost",
        port: 5432,
        database: "anvil",
        username: "anvil",
        password: "anvil"
      }
    });

    const databaseEnvironment = {
      PERSISTENCE_DRIVER: "postgres",
      DATABASE_HOST: database.host,
      DATABASE_PORT: $interpolate`${database.port}`,
      DATABASE_NAME: database.database,
      DATABASE_USER: database.username,
      DATABASE_PASSWORD: database.password
    };
    const commonServiceEnvironment = {
      RUNTIME_MODE: "production",
      OBJECT_STORE_DRIVER: "s3",
      S3_BUCKET: bucket.name,
      POPULAR_PACKAGE_INDEX_OBJECT_KEY: "popular-index/npm/latest.json",
      QUEUE_DRIVER: "sqs",
      ANALYSIS_QUEUE_URL: queue.url,
      UPSTREAM_NPM_REGISTRY: "https://registry.npmjs.org",
      NPM_DOWNLOADS_API: "https://api.npmjs.org/downloads",
      ...databaseEnvironment
    };

    new sst.aws.Task("DatabaseMigration", {
      cluster,
      image: {
        context: "../..",
        dockerfile: "packages/persistence/Dockerfile"
      },
      environment: {
        ...databaseEnvironment,
        DATABASE_READY_ATTEMPTS: "60",
        DATABASE_READY_DELAY_MS: "1000"
      },
      link: [database]
    });

    const gateway = new sst.aws.Service("Gateway", {
      cluster,
      image: {
        context: "../..",
        dockerfile: "apps/gateway/Dockerfile"
      },
      loadBalancer: {
        rules: [{ listen: "443/https", forward: "4873/http" }],
        health: {
          "4873/http": {
            path: "/-/ready",
            successCodes: "200",
            interval: "30 seconds",
            timeout: "5 seconds",
            healthyThreshold: 2,
            unhealthyThreshold: 2
          }
        }
      },
      health: {
        command: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:4873/-/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        startPeriod: "30 seconds",
        interval: "30 seconds",
        timeout: "5 seconds",
        retries: 3
      },
      environment: {
        ...commonServiceEnvironment,
        PUBLIC_BASE_URL: "https://npm.anvil.example.com",
      },
      link: [bucket, queue, database]
    });

    new sst.aws.Service("Worker", {
      cluster,
      image: {
        context: "../..",
        dockerfile: "apps/worker/Dockerfile"
      },
      health: {
        command: ["CMD", "node", "apps/worker/dist/index.js", "--health-check"],
        startPeriod: "30 seconds",
        interval: "30 seconds",
        timeout: "10 seconds",
        retries: 3
      },
      environment: commonServiceEnvironment,
      link: [bucket, queue, database]
    });

    return {
      gatewayUrl: gateway.url,
      migrationTask: "DatabaseMigration",
      databaseHost: database.host
    };
  }
});
