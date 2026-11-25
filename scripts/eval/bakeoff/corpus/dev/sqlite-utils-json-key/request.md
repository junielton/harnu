**Implement this feature request in the sqlite-utils repository checked out in your working
directory.**

**Ability to load JSON records held in a file with a single top level key that is a list of
objects**

It's very common for JSON to look like this:

```json
{
  "Version": "5.5.52.6",
  "List": [
    {
      "Description": "Nonpartisan",
      "Id": 1,
      "ExternalId": ""
    },
    {
      "Description": "Undeclared",
      "Id": 2,
      "ExternalId": ""
    }
  ]
}
```

This example taken from the records downloaded from https://www.elections.alaska.gov/election-results/e/

Right now you can't import this into `sqlite-utils` - you need to run it through `jq .List` first.

But since this is so common, it would be neat if `sqlite-utils` could have a rule of thumb that
says "if it's an object, but it has a single key that is is a list of objects, use that instead".
