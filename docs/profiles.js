/* ============================================================================
 * Profils de connexion — clés API CHIFFRÉES (AES-256-GCM, jamais en clair).
 * Déverrouillées par le mot de passe du profil sur l'écran de connexion.
 * (Re)générer un profil : ouvre  setup.html , puis colle le résultat ici.
 * ========================================================================== */
window.PROFILES = [
  { name: "Hugo", blob: {"salt":"gh7MCp5B1wKdJ4DPwaXI0g==","iv":"7Da9oiR3vWSVYZ3o","data":"Fl0bPNA4LRUwwBP1lIeCHW1N1HcOkI4yB8KLy1nXGvETBoMRYqgqynwO3jhEonEmX2Yy6wvaFClcqMkeNBQmbwid1em/o3tEhPzdgMx1GS1dskCfMakSTKBDr+hZ7VG00BHQJXZ0Lhe9r1ABmqjZjYvHgQDOdUpIGVAjmrEVRj7oxi3WSCTtpN7SSCc5C27u5q76Q0eMg0FRpQhTurLmrIaTkyQwqkRfr1M+ysPL6p0oI4tz9jcLQWyQ5/tj6nk="} },
  { name: "Julia", blob: {"salt":"VIOgV+PUwxgACByeoqWTSQ==","iv":"sF+bjJxMXTsiLvGW","data":"rbuLPPuhwXCCWvbAZ/fZLB/Tqjyx8NSPMLE1nQPC/puqba65kuwjn/eoRDp0c9nLtfOL6OS8H5VUsQfElJnGh0d6GmiJhyzQ3HWEIUj8pJScniCnW9s1XG/dPWA27EZdM+GJpuYDg7CYPu8OYD3I6sTidYZiqUXanguXDUqXccIxzIORv0mppW+bZyg2Nc0rMqPvgd386mEul5zufch9uPOk02yE/05C8BVDPT6+KwApQ5rIawf2wwHn+17esgQ="} },
  { name: "Erwan", blob: {"salt":"0wFkVZFRQ7igGnZY9SjRfA==","iv":"hGWGF+msdFrxnJo8","data":"rnMRcZahKWXQD5eIKoh9AcMXge33JnoNdobZ+vfdIl4WoAWwjTfo9K140AB57NFLz7A7gdJJyr/HycoWMkHxVkpoRYhCAX9myEFdsP/WX+TATD83Bqac4zR/ymeo9YItIN8S9n+Uly+zzTO/rp+Sx5d6/pAVMnSPMy6aFaDHzX/mgLIkhRZP0dJ64Mk/NzX+0VfWM+RFm1ebQI9uK4reqU5mrZdqs9mYerZGBfn6ohVUSsPPyA8ZP70GrbxUCFM="} },
  { name: "Caroline", blob: {"salt":"IFewYZ29XVNHdNg76u5PTg==","iv":"ieHhoa1ODsvieRsL","data":"ZJBhDR9uWrFGKYP+Uq9/ftT2rpcs+FeOQZxfiySGlOWmK+e1Uz9klHO56KojlrjbEGijeuQBNjSDx7Aciot24CEsKfXZx6keLRs83scxHk2RFt1JlFEGyZAW514jUBeqI7J/r3YXKFHyIsPZrgX+BWhaT2m17jXqTELACeaXcoxpp3YJXMyXf5DYQ5LjPU9i1BvIlvXBveuRgQPaavig3zscDMam5ZWZfogjkyikKDSpnREZg0WF1XU3Y09TEIU="} },
];
