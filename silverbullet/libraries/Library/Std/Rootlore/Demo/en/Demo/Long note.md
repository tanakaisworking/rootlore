---
tags: demo
---
# How a long note reads

As headings go deeper, a line appears on the left so you can see where you are.
Even in a long note, you can follow the headings.

## 1. Before we picked a name

At first there was no name. Starting with a placeholder and renaming later means
changing file names, links, and the guide too. So we picked the name first.

### Options

- Option A: a name about where notes live
- Option B: a name about knowledge taking root
- Option C: a name about bringing things back

### What decided it

Option B. Notes are worth more when you read them again than when you write them.
Taking root and growing felt close to that.

## 2. What to charge

We argued about how wide the free tier should be.

> If nobody uses it, we won't learn where it's hard to use.
> Open it wide first, and charge only where the cost is real.

We went with that. Details are in [[Demo/Meeting notes]].

## 3. Before launch

1. Build out the screens (11/15)
2. Write the guide (11/18)
3. Check the behavior (11/20)
4. Launch (11/25)

### What to check

- [ ] Sign in on a new device
- [ ] Read notes
- [ ] Edit and save
- [ ] Edit on two devices at once without losing anything

## 4. If you write code

```js
const notes = await fetchNotes();
const recent = notes
  .filter((note) => note.updatedAt > Date.now() - 7 * 24 * 60 * 60 * 1000)
  .sort((a, b) => b.updatedAt - a.updatedAt);
```

Code blocks have a copy button in the top right.

## 5. Last

Go back to [[Demo/Project plan]] and press a checkbox.
The mark changes right there.
