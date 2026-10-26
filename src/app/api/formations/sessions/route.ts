import { traiterCreationSession, traiterListeSessions } from '@/formations/routes'

export const GET = (request: Request) => traiterListeSessions(request)
export const POST = (request: Request) => traiterCreationSession(request)
