{
	"targets": [
		{
			"target_name": "questdbclient",
			"sources": [
			    "src/sender.cc",
			    "src/questdbclient.cc"
			],
			"include_dirs": [ "<(module_root_dir)/include" ],
	        "cflags": ["-fexceptions"],
	        "cflags_cc": ["-fexceptions"],
            "conditions": [
                [ "OS=='mac'",
                    {
                        "libraries": ["<(module_root_dir)/lib/<(OS)/<!(node -e \"console.log('%s',require('process').arch);\")/libquestdb_client.a"]
                    }
                ]
            ]
		}
	]
}
