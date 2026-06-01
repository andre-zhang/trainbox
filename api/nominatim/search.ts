import { proxyNominatim } from '../lib/nominatimProxy.js'

export default {
  fetch(request: Request) {
    return proxyNominatim('search', request)
  },
}
