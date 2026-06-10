// api/public.js — Public (no-auth) endpoints
import { Router } from 'express'
import { supabase } from './db.js'
const router = Router()

// Contact / "book a demo" form submission
router.post('/contact', async (req, res) => {
  const { name, email, company, message } = req.body || {}
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' })
  }
  const { error } = await supabase
    .from('contacts')
    .insert({ name, email, company: company || null, message: message || null })
  if (error) {
    console.error('[PUBLIC] contact insert error:', error.message)
    return res.status(500).json({ error: 'Could not submit. Please try again.' })
  }
  res.json({ success: true })
})

export default router