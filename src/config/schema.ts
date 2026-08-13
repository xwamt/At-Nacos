import { z } from 'zod';
import { stripUrlCredentials } from '../utils/url';

export const NACOS_AUTH_MODES = ['none', 'userPassword', 'customHeader', 'akSk'] as const;
export type NacosAuthMode = (typeof NACOS_AUTH_MODES)[number];

/**
 * Userinfo is dropped rather than refused, which is the difference between a
 * record this version can repair and one it can only reject.
 *
 * `http://admin:hunter2@host:8848/nacos` passes every other check here, and
 * whatever this schema accepts is what `NacosInstanceConfigManager` writes to
 * globalState -- in plaintext, in the one place the form promises credentials
 * never go. Refusing it at this layer would not undo that: `listInstances`
 * parses on the way out too, so a record an earlier build already wrote would
 * start throwing, and `listInstances` throwing replaces the entire instance
 * list with a single error node that no button in the product can clear. The
 * transform runs on read as well, so stripping instead sanitizes the stored
 * record the moment this version loads it, and the next save rewrites it
 * clean.
 *
 * A user who really did mean HTTP Basic -- a proxy in front of Nacos -- has
 * the "Custom headers" authentication mode, which is what the gateway-401
 * message already tells them to reach for.
 */
const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => stripUrlCredentials(value).replace(/\/+$/, ''))
  .refine((value) => /^https?:\/\//i.test(value), 'URL must start with http:// or https://');

export const nacosInstanceConfigSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** Carries the context path, e.g. http://host:8848/nacos or http://host:8848. */
    serverUrl: httpUrlSchema,
    /**
     * Nacos 3.x serves its console from a port of its own, e.g.
     * http://host:8080. Left unset, probing discovers it.
     */
    consoleUrl: httpUrlSchema.optional(),
    authMode: z.enum(NACOS_AUTH_MODES),
    username: z.string().trim().optional(),
    /**
     * A read-only instance disables every write button, so a connection the
     * user misremembers cannot be edited.
     */
    readOnly: z.boolean().default(false),
    /** Unattended Agent access is opt-in per instance, and off until the user says otherwise. */
    allowBackgroundAccess: z.boolean().default(false),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  /**
   * Stripping rather than the Grafana plugin's `.strict()`: later milestones
   * add fields here (a region for AK/SK), and under `.strict()` a downgraded
   * install could not read what the newer version wrote. The cost is that an
   * unknown field is not preserved -- the older version erases it the moment
   * it rewrites the record.
   */
  .strip();

export const nacosInstanceConfigListSchema = z.array(nacosInstanceConfigSchema);

export type NacosInstanceConfig = z.infer<typeof nacosInstanceConfigSchema>;

export function parseNacosInstanceConfig(value: unknown): NacosInstanceConfig {
  return nacosInstanceConfigSchema.parse(value);
}

export function parseNacosInstanceConfigList(value: unknown): NacosInstanceConfig[] {
  return nacosInstanceConfigListSchema.parse(value);
}
