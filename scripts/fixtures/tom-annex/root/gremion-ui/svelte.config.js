const config = {
  kit: {
    // a comment with a 'quoted' word and [brackets]
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'style-src': ['self', 'unsafe-inline'],
        'img-src': ['self', 'data:', 'https:'],
        'object-src': ['none']
      }
    }
  }
}

export default config
