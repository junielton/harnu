refactor!: use native `JSON.parse`

This PR removes `destr` dependency. When content-type is JSON, we strictly try `res.json()`
