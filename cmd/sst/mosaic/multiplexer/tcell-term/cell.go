package tcellterm

import "github.com/gdamore/tcell/v2"

type cell struct {
	content   rune
	combining []rune
	width     int
	attrs     tcell.Style
	wrapped   bool
}

func (c *cell) rune() rune {
	if c.content == rune(0) {
		return ' '
	}
	return c.content
}

// blank is whether the cell shows nothing: no character, and no style that
// shows, as a background color does
func (c *cell) blank() bool {
	return (c.content == 0 || c.content == ' ') && len(c.combining) == 0 && c.attrs == tcell.StyleDefault
}

// Erasing removes characters from the screen without affecting other characters
// on the screen. Erased characters are lost. The cursor position does not
// change when erasing characters or lines. Erasing resets the attributes, but
// applies the background color of the passed style
func (c *cell) erase(s tcell.Style) {
	_, bg, _ := s.Decompose()
	c.content = 0
	c.attrs = tcell.StyleDefault.Background(bg)
}

// selectiveErase removes the cell content, but keeps the attributes
func (c *cell) selectiveErase() {
	c.content = 0
}
