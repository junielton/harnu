flag value misparsed as subcommand

it looks like the parser is having trouble with space delimited persistent flags, where a sub command aligns with the value of the first of many flags:

for `./app -z one -o one two`: https://go.dev/play/p/cKaEuTEhWAZ
wanted:

```
zero: one
one: one
args: []
```

got:

```
zero: -o
one: nil
args: [one two]
```

note: this does not trigger for the following cases

```sh
app -z two two          # only one flag
app -z=two -o=one two   # using equals delimited flags
app -z one -o two two   # colliding value is not first flag
app two -z two -one one # sub command comes first
```
