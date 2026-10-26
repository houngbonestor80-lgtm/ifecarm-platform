import { traiterEtat2fa } from '@/auth/routes'

export const GET = (request: Request) => traiterEtat2fa(request)
