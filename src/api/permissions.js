// api/permissions.js — Tenant-level authorization (who inside a business can do what).
//
// WHY THIS EXISTS
// requireClient() in auth.js only asks "does this user have a tenant_id?". That was
// fine when every tenant user WAS the owner. The moment employees exist, that check
// alone would let an invited agent rewrite the AI persona and launch outbound
// campaigns. This module is the layer that stops that.
//
// THE MODEL
//   owner   — the person who signed up. Everything, including billing, agent
//             configuration, and inviting/removing people.
//   manager — runs day-to-day operations: calls, leads, campaigns, WhatsApp,
//             knowledge. Cannot change the agent's persona or manage the team.
//   agent   — front-line staff: calls + leads only (read, and update status/notes).
//
// Roles are FIXED, not per-user custom permissions. Three well-understood roles
// cover the real need; a per-user permission matrix is a support burden that buys
// very little at this stage.

// ─── Permission catalogue ────────────────────────────────────────────────────
// EVERY permission in the system, listed explicitly. This is the source of truth
// for what '*' expands to.
//
// It is spelled out rather than derived from the role table below, because some
// permissions belong to NO named role other than owner (agent:write is the
// obvious one). Deriving the catalogue by unioning the other roles silently
// dropped exactly those — which made "Agent settings" vanish from the owner's own
// navigation while the API happily allowed it.
export const ALL_PERMISSIONS = [
  'calls:read',
  'leads:read', 'leads:write',
  'campaigns:read', 'campaigns:write',
  'knowledge:read', 'knowledge:write',
  'whatsapp:read', 'whatsapp:write',
  'agent:read', 'agent:write',
  'team:read',
]

// Read/write pairs so a router can be guarded by HTTP method (see guardRouter).
export const PERMISSIONS = {
  owner: ['*'],
  manager: [
    'calls:read',
    'leads:read', 'leads:write',
    'campaigns:read', 'campaigns:write',
    'knowledge:read', 'knowledge:write',
    'whatsapp:read', 'whatsapp:write',
    'agent:read',
    'team:read',
  ],
  agent: [
    'calls:read',
    'leads:read', 'leads:write',
  ],
}

// Roles that may be handed out in an invite, weakest first. Used to validate
// input and to stop privilege escalation (see canAssignRole).
export const ASSIGNABLE_ROLES = ['agent', 'manager', 'owner']

export function isValidRole(role) {
  return ASSIGNABLE_ROLES.includes(role)
}

// Only an owner can create another owner. Everyone else is capped below their own
// level, so a manager can never mint an account more powerful than themselves.
export function canAssignRole(actorRole, targetRole) {
  if (!isValidRole(targetRole)) return false
  if (actorRole === 'owner') return true
  return false
}

// ─── Core check ──────────────────────────────────────────────────────────────
export function can(tenantRole, permission) {
  const granted = PERMISSIONS[tenantRole]
  if (!granted) return false
  return granted.includes('*') || granted.includes(permission)
}

// The flat list a client can use to hide navigation it cannot use. Hiding UI is
// cosmetic — the middleware below is what actually enforces access.
export function permissionsFor(tenantRole) {
  const granted = PERMISSIONS[tenantRole] || []
  // Expand '*' from the explicit catalogue so the frontend never has to
  // understand the wildcard — and so owner-only permissions aren't lost.
  if (granted.includes('*')) return [...ALL_PERMISSIONS]
  return [...granted]
}

// ─── Middleware ──────────────────────────────────────────────────────────────
// Mount AFTER requireClient() — it relies on req.auth being populated.
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Unauthorized' })
    if (!can(req.auth.tenantRole, permission)) {
      return res.status(403).json({
        error: 'Your role does not have access to this',
        required: permission,
        role: req.auth.tenantRole,
      })
    }
    next()
  }
}

// Owner-only shortcut for team management and billing.
export function requireOwner() {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Unauthorized' })
    if (req.auth.tenantRole !== 'owner') {
      return res.status(403).json({ error: 'Only the business owner can do this' })
    }
    next()
  }
}

// Guard a whole router by HTTP method: GET needs `read`, anything that changes
// state needs `write`. One line per router, and no new route can be added without
// inheriting a guard — which is the failure mode we care about.
export function guardRouter({ read, write }) {
  return (req, res, next) => {
    const permission = req.method === 'GET' ? read : (write || read)
    return requirePermission(permission)(req, res, next)
  }
}
