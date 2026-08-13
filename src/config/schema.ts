import { z } from 'zod';

export const NACOS_AUTH_MODES = ['none', 'userPassword', 'customHeader', 'akSk'] as const;
export type NacosAuthMode = (typeof NACOS_AUTH_MODES)[number];

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.replace(/\/+$/, ''))
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
