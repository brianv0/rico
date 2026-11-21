package main

import (
	"encoding/json"
	"os"

	"oss.terrastruct.com/d2/d2themes"
	"oss.terrastruct.com/d2/d2themes/d2themescatalog"
)

// themesdump prints the theme catalog as JSON (go run . themes), the source of public/d2/themes.js's data:
//
//	go run . themes | node genthemes.mjs > ../../public/d2/themes.generated.js
func themesdump() {
	json.NewEncoder(os.Stdout).Encode(map[string]interface{}{
		"light": d2themescatalog.LightCatalog,
		"dark":  d2themescatalog.DarkCatalog,
		"neutrals": map[string]d2themes.Neutral{
			"CoolNeutral":     d2themes.CoolNeutral,
			"WarmNeutral":     d2themes.WarmNeutral,
			"DarkNeutral":     d2themes.DarkNeutral,
			"DarkMauveNeutral": d2themes.DarkMauveNeutral,
		},
		"cli":  d2themescatalog.CLIString(),
		"zero": d2themescatalog.Find(-12345),
	})
}
