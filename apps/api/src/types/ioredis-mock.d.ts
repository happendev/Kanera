declare module "ioredis-mock" {
  import { Redis, type RedisOptions } from "ioredis";

  export default class RedisMock extends Redis {
    constructor(url?: string, options?: RedisOptions);
  }
}
