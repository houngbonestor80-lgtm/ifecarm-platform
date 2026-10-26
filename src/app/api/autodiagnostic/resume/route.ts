import { traiterResumeAutodiagnostic } from '@/autodiagnostic/routes'

export const GET = (request: Request) => traiterResumeAutodiagnostic(request)
