import { env } from '$env/dynamic/private'
export function fintsKey() { return env.FINTS_PASSWORD_KEY ?? '' }
