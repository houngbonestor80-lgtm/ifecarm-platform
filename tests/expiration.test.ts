import { describe, expect, it } from 'vitest'
import { calculerExpiration } from '@/formations/expiration'

describe('calculerExpiration', () => {
  it('retourne null si la formation n’a pas d’échéance', () => {
    expect(calculerExpiration(new Date('2026-01-15'), null)).toBeNull()
  })

  it('ajoute le nombre de mois de validité à la date d’émission', () => {
    const result = calculerExpiration(new Date('2026-01-15'), 24)
    expect(result?.getFullYear()).toBe(2028)
    expect(result?.getMonth()).toBe(0) // janvier
    expect(result?.getDate()).toBe(15)
  })

  it('gère le passage à l’année suivante', () => {
    const result = calculerExpiration(new Date('2026-11-01'), 3)
    expect(result?.getFullYear()).toBe(2027)
    expect(result?.getMonth()).toBe(1) // février
  })
})
