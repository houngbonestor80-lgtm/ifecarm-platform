import { traiterCreationEquipement, traiterListeEquipements } from '@/equipements/routes'

export const GET = (request: Request) => traiterListeEquipements(request)
export const POST = (request: Request) => traiterCreationEquipement(request)
