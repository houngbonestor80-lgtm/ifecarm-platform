import { traiterVerification2fa } from '@/auth/routes'

export const POST = (request: Request) => traiterVerification2fa(request)
