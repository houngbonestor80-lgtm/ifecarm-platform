import { traiterTableauDeBord } from '@/inspections/routes'

export async function GET(request: Request) {
  return traiterTableauDeBord(request)
}
